use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use cpal::{
	ChannelCount, Stream, StreamConfig,
	BufferSize,
};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use ringbuf::HeapRb;
use ringbuf::traits::{Consumer, Producer};

const AUDIO_SAMPLE_RATE: u32 = 44100;
const AUDIO_CHANNELS: ChannelCount = 2;
const RING_BUF_CAPACITY: usize = 16384;

pub struct CpalAudio {
	stream: Option<Stream>,
	ring_buf: Arc<Mutex<HeapRb<i16>>>,
	enabled: Arc<AtomicBool>,
}

impl CpalAudio {
	pub fn new() -> Result<Self, String> {
		let ring_buf = Arc::new(Mutex::new(HeapRb::<i16>::new(RING_BUF_CAPACITY)));
		let enabled = Arc::new(AtomicBool::new(false));

		let stream = Self::create_stream(ring_buf.clone(), enabled.clone())?;

		Ok(Self {
			stream: Some(stream),
			ring_buf,
			enabled,
		})
	}

	fn create_stream(
		ring_buf: Arc<Mutex<HeapRb<i16>>>,
		enabled: Arc<AtomicBool>,
	) -> Result<Stream, String> {
		let host = cpal::default_host();
		let device = host
			.default_output_device()
			.ok_or_else(|| "No audio output device available".to_string())?;

		let config = StreamConfig {
			channels: AUDIO_CHANNELS,
			sample_rate: AUDIO_SAMPLE_RATE,
			buffer_size: BufferSize::Default,
		};

		let stream = device
			.build_output_stream(
				&config,
				move |data: &mut [f32], _info| {
					if !enabled.load(Ordering::Relaxed) {
						for sample in data.iter_mut() {
							*sample = 0.0;
						}
						return;
					}

					let mut buf = ring_buf.lock().unwrap();
					for sample in data.iter_mut() {
						*sample = match buf.try_pop() {
							Some(s) => s as f32 / 32768.0,
							None => 0.0,
						};
					}
				},
				move |err| {
					eprintln!("Audio error: {err}");
				},
				None,
			)
			.map_err(|e| format!("Failed to build audio stream: {e}"))?;

		stream.play().map_err(|e| format!("Failed to start audio stream: {e}"))?;

		Ok(stream)
	}

	pub fn push_samples(&self, samples: &[i16]) {
		if !self.enabled.load(Ordering::Relaxed) {
			return;
		}
		if let Ok(mut buf) = self.ring_buf.lock() {
			for &sample in samples {
				let _ = buf.try_push(sample);
			}
		}
	}

	pub fn set_enabled(&self, enabled: bool) {
		self.enabled.store(enabled, Ordering::Relaxed);
	}

	pub fn is_enabled(&self) -> bool {
		self.enabled.load(Ordering::Relaxed)
	}
}

impl Drop for CpalAudio {
	fn drop(&mut self) {
		self.set_enabled(false);
		if let Some(stream) = self.stream.take() {
			let _ = stream.pause();
		}
	}
}
