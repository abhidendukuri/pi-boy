export class NativeGameBoy {
  constructor();
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

export const isAvailable: boolean;
export const loadError: unknown | null;
