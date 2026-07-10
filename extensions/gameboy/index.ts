import { promises as fs } from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, Spacer, Text, type SettingItem } from "@earendil-works/pi-tui";
import { GameBoyOverlayComponent } from "./gb-component.js";
import { createGameBoyCore } from "./gb-core.js";
import {
	DEFAULT_CONFIG,
	configExists,
	formatConfig,
	getConfigPath,
	getDefaultSaveDir,
	loadConfig,
	normalizeConfig,
	saveConfig,
	type ImageQuality,
	type GameBoyConfig,
} from "./config.js";
import { displayPath, resolvePathInput } from "./paths.js";
import { GameBoySession } from "./gb-session.js";
import { listRoms } from "./roms.js";
import { selectRomWithFilter } from "./rom-selector.js";
import { loadState } from "./saves.js";

const IMAGE_RENDER_INTERVAL_BALANCED_MS = 1000 / 30;
const IMAGE_RENDER_INTERVAL_HIGH_MS = 1000 / 60;
const TEXT_RENDER_INTERVAL_MS = 1000 / 60;

const AUDIO_OPTIONS = ["off (default)", "on"] as const;
const QUALITY_OPTIONS: Array<{ label: string; value: ImageQuality }> = [
	{ label: "Balanced (default) — 30 fps", value: "balanced" },
	{ label: "High — 60 fps", value: "high" },
];

let activeSession: GameBoySession | null = null;

// ROM selection helpers.
async function selectRom(
	args: string | undefined,
	romDir: string,
	configPath: string,
	cwd: string,
	ctx: ExtensionCommandContext,
): Promise<string | null> {
	const trimmed = args?.trim();
	if (trimmed) {
		return resolvePathInput(trimmed, cwd);
	}

	try {
		const roms = await listRoms(romDir);
		if (roms.length === 0) {
			ctx.ui.notify(`No ROMs found in ${romDir}. Update ${configPath} to set romDir.`, "warning");
			return null;
		}

		const selection = await selectRomWithFilter(ctx, roms);
		return selection;
	} catch {
		ctx.ui.notify(`Failed to read ROM directory: ${romDir}. Update ${configPath} to set romDir.`, "error");
		return null;
	}
}

// Command argument parsing.
function parseArgs(args?: string): { debug: boolean; romArg?: string } {
	if (!args) {
		return { debug: false, romArg: undefined };
	}
	const trimmed = args.trim();
	if (!trimmed) {
		return { debug: false, romArg: undefined };
	}
	const lower = trimmed.toLowerCase();
	if (lower === "debug") {
		return { debug: true, romArg: undefined };
	}
	if (lower.startsWith("debug ")) {
		return { debug: true, romArg: trimmed.slice(5).trim() || undefined };
	}
	if (lower.startsWith("--debug")) {
		return { debug: true, romArg: trimmed.slice(7).trim() || undefined };
	}
	return { debug: false, romArg: trimmed };
}

// ROM directory validation/creation.
async function ensureRomDir(pathValue: string, ctx: ExtensionCommandContext): Promise<boolean> {
	try {
		const stat = await fs.stat(pathValue);
		if (!stat.isDirectory()) {
			ctx.ui.notify(`ROM directory is not a folder: ${pathValue}`, "error");
			return false;
		}
		return true;
	} catch {
		try {
			await fs.mkdir(pathValue, { recursive: true });
			return true;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Failed to create ROM directory ${pathValue}: ${message}`, "error");
			return false;
		}
	}
}

// Config UI.
async function editConfigJson(
	ctx: ExtensionCommandContext,
	config: Awaited<ReturnType<typeof loadConfig>>,
): Promise<void> {
	const initial = formatConfig(config);
	const edited = await ctx.ui.editor("Game Boy config", initial);
	if (edited === undefined) {
		return;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(edited);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`Invalid JSON: ${message}`, "error");
		return;
	}

	const normalized = normalizeConfig(parsed);
	await saveConfig(normalized);
	ctx.ui.notify(`Saved config to ${getConfigPath()}`, "info");
}

async function configureWithWizard(
	ctx: ExtensionCommandContext,
	config: Awaited<ReturnType<typeof loadConfig>>,
): Promise<boolean> {
	const romDirDisplay = displayPath(config.romDir);
	const romDirDefaultLabel = config.romDir === DEFAULT_CONFIG.romDir ? "Use default" : "Use current";
	const romDirOptions = [
		`${romDirDefaultLabel} (${romDirDisplay}) — creates if missing`,
		"Enter a custom path (creates if missing)",
	];
	const romDirChoice = await ctx.ui.select("ROM directory", romDirOptions);
	if (!romDirChoice) {
		return false;
	}

	let romDir = config.romDir;
	if (romDirChoice === romDirOptions[1]) {
		const romDirInput = await ctx.ui.input("ROM directory (must exist)", romDirDisplay);
		if (romDirInput === undefined) {
			return false;
		}
		const trimmedRomDir = romDirInput.trim();
		if (!trimmedRomDir) {
			ctx.ui.notify("ROM directory cannot be empty.", "error");
			return false;
		}
		romDir = resolvePathInput(trimmedRomDir, ctx.cwd);
		const ensured = await ensureRomDir(romDir, ctx);
		if (!ensured) {
			return false;
		}
	} else {
		const ensured = await ensureRomDir(romDir, ctx);
		if (!ensured) {
			return false;
		}
	}

	const audioChoice = await ctx.ui.select("Audio", ["Off (default)", "On"]);
	if (!audioChoice) {
		return false;
	}
	const enableAudio = audioChoice === "On";
	const imageQuality = config.imageQuality;
	const pixelScale = config.pixelScale;

	const defaultSaveDir = getDefaultSaveDir(config.romDir);
	const shouldSyncSaveDir = config.saveDir === defaultSaveDir;
	const saveDir = shouldSyncSaveDir ? getDefaultSaveDir(romDir) : config.saveDir;
	const normalized = normalizeConfig({
		...config,
		romDir,
		saveDir,
		enableAudio,
		imageQuality,
		pixelScale,
	});
	await saveConfig(normalized);
	ctx.ui.notify(`Saved config to ${getConfigPath()}`, "info");
	await ctx.ui.select(
		"Toggle audio, quality, and more in /gameboy-config",
		["Run /gameboy to load your games"],
	);
	return true;
}

type ConfigMenuResult = "close" | "more";

type ConfigUpdate = Partial<GameBoyConfig>;

class GameBoyConfigMenu extends Container {
	private readonly settingsList: SettingsList;

	constructor(
		config: GameBoyConfig,
		theme: Theme,
		onUpdate: (update: ConfigUpdate) => void,
		onDone: (result: ConfigMenuResult) => void,
	) {
		super();
		const audioValue = config.enableAudio ? "on" : "off (default)";
		const qualityValue =
			QUALITY_OPTIONS.find((option) => option.value === config.imageQuality)?.label
			?? QUALITY_OPTIONS[0].label;
		const items: SettingItem[] = [
			{
				id: "audio",
				label: "Audio",
				description: "Enable audio output (requires native core built with audio support)",
				currentValue: audioValue,
				values: [...AUDIO_OPTIONS],
			},
			{
				id: "quality",
				label: "Quality",
				description: "Target frame rate for image rendering",
				currentValue: qualityValue,
				values: QUALITY_OPTIONS.map((option) => option.label),
			},
			{
				id: "more",
				label: "More settings",
				description: "Quick setup, advanced JSON, or reset defaults",
				currentValue: "Open",
				values: ["Open"],
			},
		];

		this.settingsList = new SettingsList(
			items,
			8,
			getSettingsListTheme(),
			(id, value) => {
				if (id === "audio") {
					onUpdate({ enableAudio: value === "on" });
					return;
				}
				if (id === "quality") {
					const option = QUALITY_OPTIONS.find((entry) => entry.label === value);
					onUpdate({ imageQuality: option?.value ?? config.imageQuality });
					return;
				}
				if (id === "more") {
					onDone("more");
				}
			},
			() => onDone("close"),
		);

		this.addChild(new DynamicBorder());
		this.addChild(new Text(theme.bold(theme.fg("accent", "Game Boy config")), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(this.settingsList);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
	}

	handleInput(data: string): void {
		this.settingsList.handleInput(data);
	}
}

async function editConfig(ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("Game Boy config requires interactive mode", "error");
		return;
	}
	const config = await loadConfig();
	const updateConfig = async (update: ConfigUpdate) => {
		const normalized = normalizeConfig({ ...config, ...update });
		await saveConfig(normalized);
		Object.assign(config, normalized);
		ctx.ui.notify(`Saved config to ${getConfigPath()}`, "info");
	};
	const action = await ctx.ui.custom<ConfigMenuResult>((_tui, theme, _keybindings, done) =>
		new GameBoyConfigMenu(config, theme, (update) => void updateConfig(update), done),
	);
	if (action !== "more") {
		return;
	}
	const choice = await ctx.ui.select("Game Boy configuration", [
		"Quick setup",
		"Advanced (edit config JSON)",
		"Reset to defaults",
	]);
	if (!choice) {
		return;
	}
	if (choice === "Quick setup") {
		await configureWithWizard(ctx, config);
		return;
	}
	if (choice === "Advanced (edit config JSON)") {
		await editConfigJson(ctx, config);
		return;
	}

	const confirm = await ctx.ui.confirm("Reset Game Boy config", "Restore defaults?");
	if (!confirm) {
		return;
	}
	await saveConfig(DEFAULT_CONFIG);
	ctx.ui.notify(`Saved config to ${getConfigPath()}`, "info");
}

// Session lifecycle.
async function createSession(romPath: string, ctx: ExtensionCommandContext, config: Awaited<ReturnType<typeof loadConfig>>): Promise<GameBoySession | null> {
	let romData: Uint8Array;
	try {
		romData = new Uint8Array(await fs.readFile(romPath));
	} catch {
		ctx.ui.notify(`Failed to read ROM: ${romPath}`, "error");
		return null;
	}

	let core;
	try {
		core = createGameBoyCore({ isDmg: config.isDmg });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`Failed to initialize Game Boy core: ${message}`, "error");
		ctx.ui.notify(
			"Build native core: cd extensions/gameboy/native/gb-core && npm install && npm run build",
			"warning",
		);
		return null;
	}

	// Load ROM first and enable audio
	try {
		core.loadRom(romData, null, config.isDmg);

		if (config.enableAudio) {
			const available = core.setAudioEnabled(true);
			if (!available) {
				const warning = core.getAudioWarning();
				ctx.ui.notify(warning ?? "Audio unavailable", "warning");
			}
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		core.dispose();
		ctx.ui.notify(`Failed to load ROM: ${message}`, "error");
		return null;
	}

	// Try to restore save state (preserves RTC, SRAM, and full emulator state)
	let savedState: Uint8Array | null = null;
	try {
		savedState = await loadState(config.saveDir, romPath);
	} catch {
		// ignore
	}
	if (savedState) {
		try {
			core.loadState(savedState);
		} catch {
			// state may be from a different version, just start fresh
		}
	}

	const session = new GameBoySession({
		core,
		romPath,
		saveDir: config.saveDir,
	});
	session.start();
	return session;
}

async function attachSession(
	session: GameBoySession,
	ctx: ExtensionCommandContext,
	config: Awaited<ReturnType<typeof loadConfig>>,
	debug = false,
): Promise<boolean> {
	let shouldStop = false;
	try {
		const isImageRenderer = config.renderer === "image";
		const overlayOptions = isImageRenderer
			? undefined
			: {
				overlay: true,
				overlayOptions: {
					width: "85%",
					maxHeight: "90%",
					anchor: "center",
					margin: { top: 1 },
				} as any,
			};

		const renderIntervalMs = config.renderer === "image"
			? config.imageQuality === "high"
				? IMAGE_RENDER_INTERVAL_HIGH_MS
				: IMAGE_RENDER_INTERVAL_BALANCED_MS
			: TEXT_RENDER_INTERVAL_MS;
		session.setRenderIntervalMs(renderIntervalMs);

		// Image mode runs in the main custom UI for best compatibility.
		// Text mode runs as an overlay.
		await ctx.ui.custom(
			(tui, _theme, _keybindings, done) => {
				session.setRenderHook(() => tui.requestRender());
				return new GameBoyOverlayComponent(
					tui,
					session.core,
					() => done(undefined),
					() => {
						shouldStop = true;
						done(undefined);
					},
					config.keybindings,
					config.renderer,
					config.pixelScale,
					isImageRenderer,
					debug,
					() => session.getStats(),
					(enabled) => session.setFastForward(enabled),
					() => {
						// Audio toggled — update footer
						tui.requestRender();
					},
				);
			},
			overlayOptions,
		);
	} finally {
		session.setRenderHook(null);
	}
	return shouldStop;
}

// Command registration.
export default function (pi: ExtensionAPI) {
	pi.on("session_shutdown", async () => {
		if (activeSession) {
			await activeSession.stop();
			activeSession = null;
		}
	});

	pi.registerCommand("gameboy", {
		description: "Play Game Boy / Game Boy Color games in pi (Ctrl+Q to detach)",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("Game Boy requires interactive mode", "error");
				return;
			}

			const trimmedArgs = args?.trim();
			if (trimmedArgs) {
				const lower = trimmedArgs.toLowerCase();
				if (lower === "config" || lower.startsWith("config ")) {
					await editConfig(ctx);
					return;
				}
			}

			const hasConfig = await configExists();
			if (!hasConfig) {
				const configured = await configureWithWizard(ctx, DEFAULT_CONFIG);
				if (!configured) {
					return;
				}
			}

			const config = await loadConfig();
			const configPath = getConfigPath();
			const { debug, romArg } = parseArgs(args);

			if (!romArg && activeSession) {
				const shouldStop = await attachSession(activeSession, ctx, config, debug);
				if (shouldStop) {
					await activeSession.stop();
					activeSession = null;
				}
				return;
			}

			const romPath = await selectRom(romArg, config.romDir, configPath, ctx.cwd, ctx);
			if (!romPath) {
				return;
			}
			const resolvedRomPath = path.resolve(romPath);

			if (activeSession && activeSession.romPath !== resolvedRomPath) {
				await activeSession.stop();
				activeSession = null;
			}

			if (!activeSession) {
				const session = await createSession(resolvedRomPath, ctx, config);
				if (!session) {
					return;
				}
				activeSession = session;
			}

			const shouldStop = await attachSession(activeSession, ctx, config, debug);
			if (shouldStop) {
				await activeSession.stop();
				activeSession = null;
			}
		},
	});

	pi.registerCommand("gameboy-config", {
		description: "Edit Game Boy configuration",
		handler: async (_args, ctx) => {
			await editConfig(ctx);
		},
	});
}
