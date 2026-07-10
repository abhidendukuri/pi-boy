import { promises as fs } from "node:fs";
import path from "node:path";

export interface RomEntry {
	path: string;
	name: string;
}

export function getRomDisplayName(romPath: string): string {
	return path.basename(romPath, path.extname(romPath));
}

const VALID_EXTENSIONS = [".gb", ".gbc"];

export async function listRoms(romDir: string): Promise<RomEntry[]> {
	const entries = await fs.readdir(romDir, { withFileTypes: true });
	return entries
		.filter((entry) => {
			if (!entry.isFile()) return false;
			const ext = path.extname(entry.name).toLowerCase();
			return VALID_EXTENSIONS.includes(ext);
		})
		.map((entry) => {
			const fullPath = path.join(romDir, entry.name);
			return {
				path: fullPath,
				name: getRomDisplayName(entry.name),
			};
		})
		.sort((a, b) => a.name.localeCompare(b.name));
}
