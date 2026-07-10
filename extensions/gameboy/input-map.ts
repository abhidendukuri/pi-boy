import { matchesKey } from "@earendil-works/pi-tui";
import type { KeyId } from "@earendil-works/pi-tui";

export type GameBoyButton = "up" | "down" | "left" | "right" | "a" | "b" | "start" | "select";

export type InputMapping = Record<GameBoyButton, string[]>;

export const DEFAULT_INPUT_MAPPING: InputMapping = {
	up: ["up", "w", "W"],
	down: ["down", "s", "S"],
	left: ["left", "a", "A"],
	right: ["right", "d", "D"],
	a: ["z", "Z"],
	b: ["x", "X"],
	start: ["enter"],
	select: ["tab"],
};

export function getMappedButtons(data: string, mapping: InputMapping = DEFAULT_INPUT_MAPPING): GameBoyButton[] {
	const matches = (keys: string[]) => keys.some((key) => matchesKey(data, key as KeyId) || data === key);
	return (Object.keys(mapping) as GameBoyButton[]).filter((button) => matches(mapping[button]));
}
