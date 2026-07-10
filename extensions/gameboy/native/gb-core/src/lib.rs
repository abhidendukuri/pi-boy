use std::io::Cursor;
use std::path::PathBuf;

use napi::bindgen_prelude::*;
use napi_derive::napi;
use tempfile::TempDir;

use mizu_core::{GameBoy, GameBoyConfig, JoypadButton};

/// Audio backend — enabled at build time with `audio-cpal` feature.
#[cfg(feature = "audio-cpal")]
mod audio_cpal;
#[cfg(feature = "audio-cpal")]
use audio_cpal::CpalAudio;

enum AudioBackend {
	#[cfg(feature = "audio-cpal")]
	Cpal(CpalAudio),
	Silent,
}

impl AudioBackend {
	fn new() -> Self {
		#[cfg(feature = "audio-cpal")]
		{
			match CpalAudio::new() {
				Ok(audio) => {
					println!("Audio: CPAL backend initialized");
					return AudioBackend::Cpal(audio);
				}
				Err(e) => {
					eprintln!("Audio: failed to initialize CPAL: {e}");
				}
			}
		}
		AudioBackend::Silent
	}

	fn set_enabled(&self, enabled: bool) -> bool {
		match self {
			#[cfg(feature = "audio-cpal")]
			AudioBackend::Cpal(audio) => {
				audio.set_enabled(enabled);
				true
			}
			_ => false,
		}
	}

	fn push_audio(&self, _samples: &[i16]) {
		#[cfg(feature = "audio-cpal")]
		if let AudioBackend::Cpal(audio) = self {
			audio.push_samples(_samples);
		}
	}
}

/// Button mapping:
/// 0=Select, 1=Start, 2=B, 3=A, 4=Down, 5=Up, 6=Left, 7=Right
fn map_button(button: u8) -> Option<JoypadButton> {
	match button {
		0 => Some(JoypadButton::Select),
		1 => Some(JoypadButton::Start),
		2 => Some(JoypadButton::B),
		3 => Some(JoypadButton::A),
		4 => Some(JoypadButton::Down),
		5 => Some(JoypadButton::Up),
		6 => Some(JoypadButton::Left),
		7 => Some(JoypadButton::Right),
		_ => None,
	}
}

/// Guess whether the ROM is DMG (original Game Boy) or CGB (Color)
/// based on the cartridge header byte at 0x143.
fn detect_is_dmg(rom_data: &[u8]) -> bool {
	if rom_data.len() > 0x144 {
		(rom_data[0x143] & 0x80) == 0
	} else {
		true
	}
}

/// Convert mizu-core audio buffers to stereo i16 samples.
/// Mizu's `all()` buffer is stereo interleaved f32: [right, left, right, left, ...].
/// CPAL expects stereo interleaved f32 in [left, right] order, so we swap the pair.
/// Each channel max is ~0.8 (4 channels / 5.0), safely within [-1, 1].
fn collect_audio_samples(gb: &mut GameBoy) -> Vec<i16> {
	let buffers = gb.audio_buffers();
	let all = buffers.all();
	if all.is_empty() {
		return Vec::new();
	}
	let mut samples = Vec::with_capacity(all.len());
	for chunk in all.chunks(2) {
		let right = chunk[0];
		let left = chunk[1];
		// CPAL expects [left, right] order
		samples.push((left.clamp(-1.0, 1.0) * 32767.0) as i16);
		samples.push((right.clamp(-1.0, 1.0) * 32767.0) as i16);
	}
	samples
}

#[napi]
pub struct NativeGameBoy {
	game_boy: Option<GameBoy>,
	temp_dir: Option<TempDir>,
	rom_path: PathBuf,
	sram_path: PathBuf,
	is_dmg: bool,
	has_battery: bool,
	audio: AudioBackend,
}

#[napi]
impl NativeGameBoy {
	#[napi(constructor)]
	pub fn new() -> Self {
		let temp_dir = TempDir::new()
			.map(|d| {
				let rom = d.path().join("rom.gb");
				let sram = d.path().join("rom.gb.sav");
				(d, rom, sram)
			});

		let (temp_dir, rom_path, sram_path) = match temp_dir {
			Ok((d, r, s)) => (Some(d), r, s),
			Err(_) => (None, PathBuf::from(""), PathBuf::from("")),
		};

		Self {
			game_boy: None,
			temp_dir,
			rom_path,
			sram_path,
			is_dmg: true,
			has_battery: false,
			audio: AudioBackend::new(),
		}
	}

	/// Load a ROM file. Can be called multiple times to switch games.
	#[napi]
	pub fn load_rom(
		&mut self,
		rom_data: Uint8Array,
		sram_data: Option<Uint8Array>,
		is_dmg: Option<bool>,
	) -> Result<()> {
		self.game_boy = None;

		let rom_bytes = rom_data.to_vec();
		let is_dmg = is_dmg.unwrap_or_else(|| detect_is_dmg(&rom_bytes));

		if self.temp_dir.is_none() {
			let dir = TempDir::new()
				.map_err(|e| Error::from_reason(format!("Failed to create temp dir: {e}")))?;
			self.rom_path = dir.path().join("rom.gb");
			self.sram_path = dir.path().join("rom.gb.sav");
			self.temp_dir = Some(dir);
		}

		std::fs::write(&self.rom_path, &rom_bytes)
			.map_err(|e| Error::from_reason(format!("Failed to write ROM: {e}")))?;

		if let Some(sram) = sram_data {
			std::fs::write(&self.sram_path, sram.to_vec())
				.map_err(|e| Error::from_reason(format!("Failed to write SRAM: {e}")))?;
		}

		let config = GameBoyConfig { is_dmg };

		let game_boy = GameBoy::builder(&self.rom_path)
			.config(config)
			.sram_file(&self.sram_path)
			.save_on_shutdown(false)
			.build()
			.map_err(|e| Error::from_reason(format!("Failed to load ROM: {e}")))?;

		self.has_battery = game_boy.has_battery();
		self.is_dmg = is_dmg;
		self.game_boy = Some(game_boy);

		Ok(())
	}

	/// Advance the emulator by one frame (≈16.67ms). Also pushes audio if enabled.
	#[napi]
	pub fn tick(&mut self) {
		if let Some(gb) = &mut self.game_boy {
			gb.clock_for_frame();
			let samples = collect_audio_samples(gb);
			if !samples.is_empty() {
				self.audio.push_audio(&samples);
			}
		}
	}

	/// Get the current frame buffer as RGB pixel data.
	/// Game Boy screen is 160x144 pixels = 69,120 bytes (3 bytes per pixel).
	#[napi]
	pub fn get_frame_buffer(&self) -> Uint8Array {
		if let Some(gb) = &self.game_boy {
			let buffer = gb.screen_buffer();
			Uint8Array::new(buffer.to_vec())
		} else {
			Uint8Array::new(vec![])
		}
	}

	/// Press a button (0-7).
	#[napi]
	pub fn press_button(&mut self, button: u8) {
		if let Some(gb) = &mut self.game_boy {
			if let Some(b) = map_button(button) {
				gb.press_joypad(b);
			}
		}
	}

	/// Release a button (0-7).
	#[napi]
	pub fn release_button(&mut self, button: u8) {
		if let Some(gb) = &mut self.game_boy {
			if let Some(b) = map_button(button) {
				gb.release_joypad(b);
			}
		}
	}

	/// Enable or disable audio output. Returns true if audio is available.
	#[napi]
	pub fn set_audio_enabled(&mut self, enabled: bool) -> bool {
		self.audio.set_enabled(enabled)
	}

	/// Whether the cartridge has battery-backed RAM.
	#[napi]
	pub fn has_battery(&self) -> bool {
		self.has_battery
	}

	/// Get the battery-backed SRAM data, if present.
	#[napi]
	pub fn get_sram(&self) -> Option<Uint8Array> {
		self.game_boy.as_ref().and_then(|gb| {
			gb.get_sram().map(|data| Uint8Array::new(data.to_vec()))
		})
	}

	/// Set the battery-backed SRAM data.
	#[napi]
	pub fn set_sram(&mut self, data: Uint8Array) {
		if let Some(gb) = &mut self.game_boy {
			if let Some(sram) = gb.get_sram_mut() {
				let len = sram.len().min(data.len());
				sram[..len].copy_from_slice(&data[..len]);
			}
		}
	}

	/// Save SRAM to the .sav file on disk.
	#[napi]
	pub fn save_sram_to_file(&self) -> Result<()> {
		self.game_boy
			.as_ref()
			.ok_or_else(|| Error::from_reason("GameBoy not initialized".to_string()))?
			.save_sram_to_file()
			.map_err(|e| Error::from_reason(format!("Failed to save SRAM: {e}")))
	}

	/// Save the full emulator state as compressed bytes.
	#[napi]
	pub fn save_state(&self) -> Result<Uint8Array> {
		let gb = self
			.game_boy
			.as_ref()
			.ok_or_else(|| Error::from_reason("GameBoy not initialized".to_string()))?;
		let mut cursor = Cursor::new(Vec::new());
		gb.save_state(&mut cursor)
			.map_err(|e| Error::from_reason(format!("Failed to save state: {e}")))?;
		Ok(Uint8Array::new(cursor.into_inner()))
	}

	/// Load a full emulator state from compressed bytes.
	#[napi]
	pub fn load_state(&mut self, data: Uint8Array) -> Result<()> {
		let gb = self
			.game_boy
			.as_mut()
			.ok_or_else(|| Error::from_reason("GameBoy not initialized".to_string()))?;
		let mut cursor = Cursor::new(data.to_vec());
		gb.load_state(&mut cursor)
			.map_err(|e| Error::from_reason(format!("Failed to load state: {e}")))?;
		Ok(())
	}

	/// Get the game title from the cartridge header.
	#[napi]
	pub fn game_title(&self) -> String {
		self.game_boy
			.as_ref()
			.map_or_else(String::new, |gb| gb.game_title().to_string())
	}

	/// Whether the emulator is in DMG (original Game Boy) mode.
	#[napi]
	pub fn get_is_dmg(&self) -> bool {
		self.is_dmg
	}

	/// Get an audio warning message if audio was requested but unavailable.
	#[napi]
	pub fn get_audio_warning(&self) -> Option<String> {
		#[cfg(not(feature = "audio-cpal"))]
		{
			Some("Audio output unavailable. Rebuild the native core with --features audio-cpal.".to_string())
		}
		#[cfg(feature = "audio-cpal")]
		{
			None
		}
	}

	/// Clean up resources.
	#[napi]
	pub fn dispose(&mut self) {
		self.audio.set_enabled(false);
		if let Some(gb) = self.game_boy.take() {
			let _ = gb.save_sram_to_file();
		}
		if let Some(dir) = self.temp_dir.take() {
			let _ = dir.close();
		}
	}
}
