import {
	App,
	FuzzySuggestModal,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	normalizePath,
} from "obsidian";

interface VaultProfileSettings {
	profileFolder: string;
}

const DEFAULT_SETTINGS: VaultProfileSettings = {
	profileFolder: "VaultProfiles",
};

// Per-device UI state, not part of a portable profile: current pane layout / open tabs.
const EXCLUDED_BASENAMES = new Set(["workspace.json", "workspace-mobile.json"]);

interface ProfileBundle {
	formatVersion: 1;
	createdAt: string;
	vaultName: string;
	obsidianConfigDir: string;
	files: Record<string, string>;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
	let binary = "";
	const bytes = new Uint8Array(buffer);
	const chunkSize = 0x8000;
	for (let i = 0; i < bytes.length; i += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
	}
	return btoa(binary);
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes.buffer;
}

export default class VaultProfilePlugin extends Plugin {
	settings!: VaultProfileSettings;

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new VaultProfileSettingTab(this.app, this));

		this.addCommand({
			id: "export-vault-profile",
			name: "Profil exportieren (Settings + Plugins)",
			callback: () => this.promptExport(),
		});

		this.addCommand({
			id: "import-vault-profile",
			name: "Profil importieren",
			callback: () => {
				const files = this.getProfileFiles();
				if (files.length === 0) {
					new Notice(`Keine Profil-Dateien in "${this.settings.profileFolder}" gefunden.`);
					return;
				}
				new ProfilePickerModal(this.app, files, (file) => this.promptImport(file)).open();
			},
		});

		this.addCommand({
			id: "delete-vault-profile",
			name: "Profil löschen",
			callback: () => {
				const files = this.getProfileFiles();
				if (files.length === 0) {
					new Notice(`Keine Profil-Dateien in "${this.settings.profileFolder}" gefunden.`);
					return;
				}
				new ProfilePickerModal(this.app, files, (file) => {
					new ConfirmModal(this.app, `Profil "${file.basename}" endgültig löschen?`, async () => {
						await this.app.fileManager.trashFile(file);
						new Notice(`Profil "${file.basename}" gelöscht.`);
					}).open();
				}).open();
			},
		});
	}

	getProfileFiles(): TFile[] {
		const folder = normalizePath(this.settings.profileFolder);
		return this.app.vault
			.getFiles()
			.filter((f) => f.path.startsWith(folder + "/") && f.extension === "json")
			.sort((a, b) => b.stat.mtime - a.stat.mtime);
	}

	promptExport(onComplete?: () => void) {
		const today = new Date().toISOString().slice(0, 10);
		const defaultName = `Profile-${this.app.vault.getName()}-${today}`;
		new NameInputModal(this.app, defaultName, async (name) => {
			const folder = normalizePath(this.settings.profileFolder);
			const path = normalizePath(`${folder}/${name}.json`);
			if (await this.app.vault.adapter.exists(path)) {
				new ConfirmModal(this.app, `Profil "${name}" existiert bereits. Überschreiben?`, async () => {
					await this.exportProfile(name);
					onComplete?.();
				}).open();
			} else {
				await this.exportProfile(name);
				onComplete?.();
			}
		}).open();
	}

	promptImport(file: TFile) {
		new ConfirmModal(
			this.app,
			`Profil "${file.basename}" importieren? Das überschreibt aktuelle Einstellungen, Erscheinungsbild, Hotkeys und Community-Plugins in diesem Vault.`,
			async () => {
				await this.importProfile(file);
			}
		).open();
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	private async listAllFiles(dir: string): Promise<string[]> {
		const adapter = this.app.vault.adapter;
		const res = await adapter.list(dir);
		let files = [...res.files];
		for (const folder of res.folders) {
			files = files.concat(await this.listAllFiles(folder));
		}
		return files;
	}

	private async ensureFolderRecursive(folderPath: string) {
		const adapter = this.app.vault.adapter;
		const parts = folderPath.split("/").filter(Boolean);
		let current = "";
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			if (!(await adapter.exists(current))) {
				await adapter.mkdir(current);
			}
		}
	}

	async exportProfile(name: string) {
		const adapter = this.app.vault.adapter;
		const configDir = this.app.vault.configDir;

		const allPaths = await this.listAllFiles(configDir);
		const filtered = allPaths.filter((p) => !EXCLUDED_BASENAMES.has(p.split("/").pop() ?? ""));

		const files: Record<string, string> = {};
		for (const path of filtered) {
			const rel = path.substring(configDir.length + 1);
			try {
				const buf = await adapter.readBinary(path);
				files[rel] = arrayBufferToBase64(buf);
			} catch (e) {
				console.error(`Vault Profile Sync: konnte ${path} nicht lesen`, e);
			}
		}

		const bundle: ProfileBundle = {
			formatVersion: 1,
			createdAt: new Date().toISOString(),
			vaultName: this.app.vault.getName(),
			obsidianConfigDir: configDir,
			files,
		};

		const folder = normalizePath(this.settings.profileFolder);
		await this.ensureFolderRecursive(folder);
		const path = normalizePath(`${folder}/${name}.json`);
		await adapter.write(path, JSON.stringify(bundle));
		new Notice(`Profil exportiert: ${path}\n(${Object.keys(files).length} Dateien)`);
	}

	async importProfile(file: TFile) {
		const adapter = this.app.vault.adapter;
		const configDir = this.app.vault.configDir;

		let bundle: ProfileBundle;
		try {
			const content = await this.app.vault.read(file);
			bundle = JSON.parse(content);
		} catch (e) {
			new Notice("Profil-Datei konnte nicht gelesen/geparst werden.");
			console.error("Vault Profile Sync: Import fehlgeschlagen", e);
			return;
		}

		if (!bundle.files || bundle.formatVersion !== 1) {
			new Notice("Unbekanntes Profil-Format.");
			return;
		}

		let count = 0;
		for (const [rel, b64] of Object.entries(bundle.files)) {
			const target = normalizePath(`${configDir}/${rel}`);
			const dir = target.substring(0, target.lastIndexOf("/"));
			if (dir) {
				await this.ensureFolderRecursive(dir);
			}
			try {
				await adapter.writeBinary(target, base64ToArrayBuffer(b64));
				count++;
			} catch (e) {
				console.error(`Vault Profile Sync: konnte ${target} nicht schreiben`, e);
			}
		}

		new Notice(
			`Profil importiert (${count} Dateien). Bitte Obsidian jetzt komplett schließen und neu öffnen, damit alle Änderungen inkl. neuer Plugins wirksam werden.`,
			10000
		);
	}
}

class NameInputModal extends Modal {
	private result: string;
	private onSubmit: (result: string) => void;

	constructor(app: App, defaultName: string, onSubmit: (result: string) => void) {
		super(app);
		this.result = defaultName;
		this.onSubmit = onSubmit;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: "Profil exportieren" });
		const input = contentEl.createEl("input", { type: "text", value: this.result });
		input.style.width = "100%";
		input.addEventListener("input", (e) => {
			this.result = (e.target as HTMLInputElement).value;
		});
		input.focus();
		input.select();

		new Setting(contentEl).addButton((btn) =>
			btn
				.setButtonText("Exportieren")
				.setCta()
				.onClick(() => {
					if (!this.result.trim()) return;
					this.close();
					this.onSubmit(this.result.trim());
				})
		);

		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && this.result.trim()) {
				this.close();
				this.onSubmit(this.result.trim());
			}
		});
	}

	onClose() {
		this.contentEl.empty();
	}
}

class ProfilePickerModal extends FuzzySuggestModal<TFile> {
	private files: TFile[];
	private onChoose: (file: TFile) => void;

	constructor(app: App, files: TFile[], onChoose: (file: TFile) => void) {
		super(app);
		this.files = files;
		this.onChoose = onChoose;
		this.setPlaceholder("Profil auswählen...");
	}

	getItems(): TFile[] {
		return this.files;
	}

	getItemText(item: TFile): string {
		return item.path;
	}

	onChooseItem(item: TFile): void {
		this.onChoose(item);
	}
}

class ConfirmModal extends Modal {
	private message: string;
	private onConfirm: () => void;

	constructor(app: App, message: string, onConfirm: () => void) {
		super(app);
		this.message = message;
		this.onConfirm = onConfirm;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("p", { text: this.message });
		new Setting(contentEl)
			.addButton((btn) => btn.setButtonText("Abbrechen").onClick(() => this.close()))
			.addButton((btn) =>
				btn
					.setButtonText("Importieren")
					.setWarning()
					.onClick(() => {
						this.close();
						this.onConfirm();
					})
			);
	}

	onClose() {
		this.contentEl.empty();
	}
}

class VaultProfileSettingTab extends PluginSettingTab {
	plugin: VaultProfilePlugin;

	constructor(app: App, plugin: VaultProfilePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Profilordner")
			.setDesc(
				"Vault-interner Ordner, in dem Profil-Dateien gespeichert und gesucht werden. Diesen Ordner (bzw. die Profil-Datei darin) manuell über iCloud/Obsidian Sync/AirDrop/Files-App in den Ziel-Vault bringen."
			)
			.addText((text) =>
				text.setValue(this.plugin.settings.profileFolder).onChange(async (value) => {
					this.plugin.settings.profileFolder = value.trim() || DEFAULT_SETTINGS.profileFolder;
					await this.plugin.saveSettings();
					this.display();
				})
			);

		new Setting(containerEl).setName("Profile").setHeading();

		const files = this.plugin.getProfileFiles();
		if (files.length === 0) {
			containerEl.createEl("p", {
				text: `Noch keine Profile in "${this.plugin.settings.profileFolder}".`,
				cls: "setting-item-description",
			});
		}

		for (const file of files) {
			const date = new Date(file.stat.mtime).toLocaleString();
			new Setting(containerEl)
				.setName(file.basename)
				.setDesc(`Zuletzt geändert: ${date}`)
				.addButton((btn) =>
					btn.setButtonText("Importieren").onClick(() => this.plugin.promptImport(file))
				)
				.addButton((btn) =>
					btn
						.setButtonText("Löschen")
						.setWarning()
						.onClick(() => {
							new ConfirmModal(this.app, `Profil "${file.basename}" endgültig löschen?`, async () => {
								await this.plugin.app.fileManager.trashFile(file);
								this.display();
							}).open();
						})
				);
		}

		new Setting(containerEl).addButton((btn) =>
			btn
				.setButtonText("Neues Profil exportieren")
				.setCta()
				.onClick(() => this.plugin.promptExport(() => this.display()))
		);
	}
}
