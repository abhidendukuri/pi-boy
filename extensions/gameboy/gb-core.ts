import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export type GameBoyButton = "up" | "down" | "left" | "right" | "a" | "b" | "start" | "select";

export interface FrameBuffer {
	data: Uint8Array;
}

export interface GameBoyCore {
	loadRom(rom: Uint8Array, sram?: Uint8Array | null, isDmg?: boolean | null): void;
	tick(): void;
	getFrameBuffer(): FrameBuffer;
	setButton(button: GameBoyButton, pressed: boolean): void;
	setAudioEnabled(enabled: boolean): boolean;
	getAudioWarning(): string | null;
	hasBattery(): boolean;
	getSram(): Uint8Array | null;
	setSram(sram: Uint8Array): void;
	saveSramToFile(): void;
	saveState(): Uint8Array;
	loadState(data: Uint8Array): void;
	gameTitle(): string;
	getIsDmg(): boolean;
	dispose(): void;
}

export interface CreateGameBoyCoreOptions {
	isDmg?: boolean;
}

interface NativeGameBoyInstance {
	loadRom(romData: Uint8Array, sramData?: Uint8Array | null, isDmg?: boolean | null): void;
	tick(): void;
	getFrameBuffer(): Uint8Array;
	pressButton(button: number): void;
	releaseButton(button: number): void;
	setAudioEnabled(enabled: boolean): boolean;
	hasBattery(): boolean;
	getSram(): Uint8Array | null;
	setSram(data: Uint8Array): void;
	saveSramToFile(): void;
	saveState(): Uint8Array;
	loadState(data: Uint8Array): void;
	gameTitle(): string;
	getIsDmg(): boolean;
	getAudioWarning(): string | null;
	dispose(): void;
}

interface NativeGameBoyClass {
	new(): NativeGameBoyInstance;
}

interface NativeGameBoyModule {
	isAvailable: boolean;
	loadError: unknown | null;
	NativeGameBoy: NativeGameBoyClass;
}

let nativeModule: NativeGameBoyModule | null | undefined;

function getNativeModule(): NativeGameBoyModule | null {
	if (nativeModule !== undefined) {
		return nativeModule;
	}
	try {
		const loaded = require("./native/gb-core/index.js") as NativeGameBoyModule;
		nativeModule = loaded?.isAvailable ? loaded : null;
	} catch {
		nativeModule = null;
	}
	return nativeModule;
}

const NATIVE_BUTTON_MAP: Record<GameBoyButton, number> = {
	select: 0,
	start: 1,
	b: 2,
	a: 3,
	down: 4,
	up: 5,
	left: 6,
	right: 7,
};

export class NativeGameBoyCore implements GameBoyCore {
	private gb: NativeGameBoyInstance | null = null;
	private nativeClass: NativeGameBoyClass | null = null;

	constructor(_options: CreateGameBoyCoreOptions = {}) {
		const module = getNativeModule();
		if (!module) {
			throw new Error("Native Game Boy core addon is not available.");
		}
		this.nativeClass = module.NativeGameBoy;
		this.gb = new module.NativeGameBoy();
	}

	loadRom(rom: Uint8Array, sram?: Uint8Array | null, isDmg?: boolean | null): void {
		if (!this.gb || !this.nativeClass) {
			throw new Error("Native Game Boy core addon is not available.");
		}
		this.gb.loadRom(rom, sram ?? null, isDmg ?? null);
	}

	tick(): void {
		this.gb?.tick();
	}

	getFrameBuffer(): FrameBuffer {
		return { data: this.gb?.getFrameBuffer() ?? new Uint8Array(0) };
	}

	setButton(button: GameBoyButton, pressed: boolean): void {
		const mapped = NATIVE_BUTTON_MAP[button];
		if (pressed) {
			this.gb?.pressButton(mapped);
		} else {
			this.gb?.releaseButton(mapped);
		}
	}

	hasBattery(): boolean {
		return this.gb?.hasBattery() ?? false;
	}

	getSram(): Uint8Array | null {
		return this.gb?.getSram() ?? null;
	}

	setSram(sram: Uint8Array): void {
		this.gb?.setSram(sram);
	}

	saveSramToFile(): void {
		this.gb?.saveSramToFile();
	}

	saveState(): Uint8Array {
		return this.gb?.saveState() ?? new Uint8Array(0);
	}

	loadState(data: Uint8Array): void {
		this.gb?.loadState(data);
	}

	gameTitle(): string {
		return this.gb?.gameTitle() ?? "";
	}

	getIsDmg(): boolean {
		return this.gb?.getIsDmg() ?? true;
	}

	setAudioEnabled(enabled: boolean): boolean {
		return this.gb?.setAudioEnabled(enabled) ?? false;
	}

	getAudioWarning(): string | null {
		return this.gb?.getAudioWarning() ?? null;
	}

	dispose(): void {
		if (this.gb) {
			this.gb.dispose();
			this.gb = null;
		}
	}
}

export function createGameBoyCore(options: CreateGameBoyCoreOptions = {}): GameBoyCore {
	return new NativeGameBoyCore(options);
}
