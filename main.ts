import {
	App,
	FuzzySuggestModal,
	Menu,
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
	excludedPlugins: string[];
	autoBackupBeforeImport: boolean;
}

const DEFAULT_SETTINGS: VaultProfileSettings = {
	profileFolder: "VaultProfiles",
	excludedPlugins: [],
	autoBackupBeforeImport: true,
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

interface EncryptedEnvelope {
	encrypted: true;
	kdf: "PBKDF2";
	iterations: number;
	salt: string;
	iv: string;
	ciphertext: string;
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

function pluginIdsInBundle(bundle: ProfileBundle): string[] {
	const ids = new Set<string>();
	for (const rel of Object.keys(bundle.files)) {
		if (rel.startsWith("plugins/")) {
			const id = rel.split("/")[1];
			if (id) ids.add(id);
		}
	}
	return Array.from(ids).sort();
}

async function encryptBundle(bundle: ProfileBundle, passphrase: string): Promise<EncryptedEnvelope> {
	const iterations = 200_000;
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const keyMaterial = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(passphrase),
		"PBKDF2",
		false,
		["deriveKey"]
	);
	const key = await crypto.subtle.deriveKey(
		{ name: "PBKDF2", salt, iterations, hash: "SHA-256" },
		keyMaterial,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt"]
	);
	const plaintext = new TextEncoder().encode(JSON.stringify(bundle));
	const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
	return {
		encrypted: true,
		kdf: "PBKDF2",
		iterations,
		salt: arrayBufferToBase64(salt.buffer),
		iv: arrayBufferToBase64(iv.buffer),
		ciphertext: arrayBufferToBase64(ciphertext),
	};
}

async function decryptEnvelope(envelope: EncryptedEnvelope, passphrase: string): Promise<ProfileBundle> {
	const salt = new Uint8Array(base64ToArrayBuffer(envelope.salt));
	const iv = new Uint8Array(base64ToArrayBuffer(envelope.iv));
	const keyMaterial = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(passphrase),
		"PBKDF2",
		false,
		["deriveKey"]
	);
	const key = await crypto.subtle.deriveKey(
		{ name: "PBKDF2", salt, iterations: envelope.iterations, hash: "SHA-256" },
		keyMaterial,
		{ name: "AES-GCM", length: 256 },
		false,
		["decrypt"]
	);
	const ciphertext = base64ToArrayBuffer(envelope.ciphertext);
	const plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
	return JSON.parse(new TextDecoder().decode(plainBuf));
}

export default class VaultProfilePlugin extends Plugin {
	settings!: VaultProfileSettings;

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new VaultProfileSettingTab(this.app, this));

		this.addRibbonIcon("layers", "Vault Profile Sync", (evt) => {
			const menu = new Menu();
			menu.addItem((item) =>
				item
					.setTitle("Profil exportieren")
					.setIcon("upload")
					.onClick(() => this.promptExport())
			);
			menu.addItem((item) =>
				item
					.setTitle("Profil teilen")
					.setIcon("share-2")
					.onClick(() => this.promptShareFlow())
			);
			menu.addItem((item) =>
				item
					.setTitle("Profil importieren (aus Vault)")
					.setIcon("download")
					.onClick(() => this.promptImportFlow())
			);
			menu.addItem((item) =>
				item
					.setTitle("Datei importieren (von Gerät)")
					.setIcon("file-input")
					.onClick(() => this.importFromExternalFile())
			);
			menu.addItem((item) =>
				item
					.setTitle("Profil löschen")
					.setIcon("trash")
					.onClick(() => this.promptDeleteFlow())
			);
			menu.showAtMouseEvent(evt);
		});

		this.addCommand({
			id: "export-vault-profile",
			name: "Profil exportieren (Settings + Plugins)",
			callback: () => this.promptExport(),
		});

		this.addCommand({
			id: "share-vault-profile",
			name: "Profil teilen",
			callback: () => this.promptShareFlow(),
		});

		this.addCommand({
			id: "import-vault-profile",
			name: "Profil importieren (aus Vault)",
			callback: () => this.promptImportFlow(),
		});

		this.addCommand({
			id: "import-vault-profile-from-device",
			name: "Datei importieren (von Gerät)",
			callback: () => this.importFromExternalFile(),
		});

		this.addCommand({
			id: "delete-vault-profile",
			name: "Profil löschen",
			callback: () => this.promptDeleteFlow(),
		});
	}

	promptShareFlow() {
		const files = this.getProfileFiles();
		if (files.length === 0) {
			new Notice(`Keine Profil-Dateien in "${this.settings.profileFolder}" gefunden.`);
			return;
		}
		new ProfilePickerModal(this.app, files, (file) => this.shareProfileFile(file)).open();
	}

	async shareProfileFile(file: TFile) {
		const content = await this.app.vault.read(file);
		const blob = new Blob([content], { type: "application/json" });
		const nav = navigator as any;

		if (nav.canShare && nav.share) {
			const shareFile = new File([blob], file.name, { type: "application/json" });
			if (nav.canShare({ files: [shareFile] })) {
				try {
					await nav.share({ files: [shareFile], title: file.name });
					return;
				} catch (e) {
					if ((e as Error)?.name === "AbortError") return;
					console.error("Vault Profile Sync: Teilen fehlgeschlagen, falle zurück auf Download", e);
				}
			}
		}

		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = file.name;
		document.body.appendChild(a);
		a.click();
		a.remove();
		URL.revokeObjectURL(url);
	}

	importFromExternalFile() {
		const input = document.createElement("input");
		input.type = "file";
		input.accept = ".json,application/json";
		input.style.display = "none";
		input.addEventListener("change", async () => {
			const picked = input.files?.[0];
			input.remove();
			if (!picked) return;

			const text = await picked.text();
			const bundle = await this.resolveBundle(text);
			if (!bundle) return;

			new ImportPreviewModal(this.app, bundle, async (filtered) => {
				await this.applyBundle(filtered);

				const folder = normalizePath(this.settings.profileFolder);
				await this.ensureFolderRecursive(folder);
				const baseName = picked.name.replace(/\.json$/i, "");
				const path = normalizePath(`${folder}/${baseName}.json`);
				await this.app.vault.adapter.write(path, text);
			}).open();
		});
		document.body.appendChild(input);
		input.click();
	}

	promptImportFlow() {
		const files = this.getProfileFiles();
		if (files.length === 0) {
			new Notice(`Keine Profil-Dateien in "${this.settings.profileFolder}" gefunden.`);
			return;
		}
		new ProfilePickerModal(this.app, files, (file) => this.promptImport(file)).open();
	}

	async promptImport(file: TFile) {
		const content = await this.app.vault.read(file);
		const bundle = await this.resolveBundle(content);
		if (!bundle) return;
		new ImportPreviewModal(this.app, bundle, (filtered) => this.applyBundle(filtered)).open();
	}

	/** Parses profile file content into a usable bundle, prompting for a passphrase and decrypting if needed. Shows its own error Notices and returns null on any failure/cancellation. */
	async resolveBundle(text: string): Promise<ProfileBundle | null> {
		let parsed: any;
		try {
			parsed = JSON.parse(text);
		} catch (e) {
			new Notice("Datei konnte nicht gelesen werden (kein gültiges JSON).");
			return null;
		}

		if (parsed && parsed.encrypted === true) {
			const passphrase = await promptPassphrase(this.app);
			if (passphrase === null) return null;
			try {
				const bundle = await decryptEnvelope(parsed as EncryptedEnvelope, passphrase);
				if (!bundle.files || bundle.formatVersion !== 1) {
					new Notice("Entschlüsselung ergab ein unbekanntes Profil-Format.");
					return null;
				}
				return bundle;
			} catch (e) {
				new Notice("Falsches Passwort oder beschädigte Datei.");
				return null;
			}
		}

		if (!parsed || !parsed.files || parsed.formatVersion !== 1) {
			new Notice("Unbekanntes Profil-Format.");
			return null;
		}
		return parsed as ProfileBundle;
	}

	promptDeleteFlow() {
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
		new ExportModal(this.app, defaultName, async (name, passphrase) => {
			const doExport = async () => {
				await this.exportProfile(name, passphrase || undefined);
				onComplete?.();
			};
			const folder = normalizePath(this.settings.profileFolder);
			const path = normalizePath(`${folder}/${name}.json`);
			if (await this.app.vault.adapter.exists(path)) {
				new ConfirmModal(this.app, `Profil "${name}" existiert bereits. Überschreiben?`, doExport).open();
			} else {
				await doExport();
			}
		}).open();
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

	private async buildBundle(): Promise<ProfileBundle> {
		const adapter = this.app.vault.adapter;
		const configDir = this.app.vault.configDir;
		const excluded = new Set(this.settings.excludedPlugins);

		const allPaths = await this.listAllFiles(configDir);
		const filtered = allPaths.filter((p) => {
			if (EXCLUDED_BASENAMES.has(p.split("/").pop() ?? "")) return false;
			const rel = p.substring(configDir.length + 1);
			const [first, second] = rel.split("/");
			return !(first === "plugins" && excluded.has(second));
		});

		const files: Record<string, string> = {};
		for (const path of filtered) {
			const rel = path.substring(configDir.length + 1);
			try {
				if (rel === "community-plugins.json" && excluded.size > 0) {
					// Strip excluded plugin ids so the target vault isn't told to enable a plugin whose files we didn't include.
					const raw = await adapter.read(path);
					const enabled: string[] = JSON.parse(raw);
					const cleaned = enabled.filter((id) => !excluded.has(id));
					files[rel] = arrayBufferToBase64(new TextEncoder().encode(JSON.stringify(cleaned)).buffer);
				} else {
					const buf = await adapter.readBinary(path);
					files[rel] = arrayBufferToBase64(buf);
				}
			} catch (e) {
				console.error(`Vault Profile Sync: konnte ${path} nicht lesen`, e);
			}
		}

		return {
			formatVersion: 1,
			createdAt: new Date().toISOString(),
			vaultName: this.app.vault.getName(),
			obsidianConfigDir: configDir,
			files,
		};
	}

	async exportProfile(name: string, passphrase?: string, opts?: { silent?: boolean }): Promise<string> {
		const bundle = await this.buildBundle();
		const folder = normalizePath(this.settings.profileFolder);
		await this.ensureFolderRecursive(folder);
		const path = normalizePath(`${folder}/${name}.json`);
		const content = passphrase ? JSON.stringify(await encryptBundle(bundle, passphrase)) : JSON.stringify(bundle);
		await this.app.vault.adapter.write(path, content);
		if (!opts?.silent) {
			new Notice(
				`Profil exportiert: ${path}\n(${Object.keys(bundle.files).length} Dateien${
					passphrase ? ", verschlüsselt" : ""
				})`
			);
		}
		return path;
	}

	async applyBundle(bundle: ProfileBundle) {
		if (this.settings.autoBackupBeforeImport) {
			const stamp = new Date().toISOString().replace(/[:.]/g, "-");
			try {
				await this.exportProfile(`AutoBackup-vor-Import-${stamp}`, undefined, { silent: true });
			} catch (e) {
				console.error("Vault Profile Sync: Auto-Backup vor Import fehlgeschlagen", e);
			}
		}

		const adapter = this.app.vault.adapter;
		const configDir = this.app.vault.configDir;

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
			`Profil importiert (${count} Dateien).${
				this.settings.autoBackupBeforeImport ? " Automatisches Backup des vorherigen Zustands wurde angelegt." : ""
			} Bitte Obsidian jetzt komplett schließen und neu öffnen, damit alle Änderungen inkl. neuer Plugins wirksam werden.`,
			10000
		);
	}
}

function promptPassphrase(app: App): Promise<string | null> {
	return new Promise((resolve) => {
		new PassphraseModal(
			app,
			(pass) => resolve(pass),
			() => resolve(null)
		).open();
	});
}

class PassphraseModal extends Modal {
	private value = "";
	private onSubmit: (passphrase: string) => void;
	private onCancel: () => void;

	constructor(app: App, onSubmit: (passphrase: string) => void, onCancel: () => void) {
		super(app);
		this.onSubmit = onSubmit;
		this.onCancel = onCancel;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: "Profil ist verschlüsselt" });
		contentEl.createEl("p", { text: "Passwort eingeben, um es zu entschlüsseln." });

		const input = contentEl.createEl("input", { type: "password" });
		input.style.width = "100%";
		input.addEventListener("input", (e) => {
			this.value = (e.target as HTMLInputElement).value;
		});
		input.focus();

		const submit = () => {
			this.close();
			this.onSubmit(this.value);
		};

		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") submit();
		});

		new Setting(contentEl)
			.addButton((btn) => btn.setButtonText("Abbrechen").onClick(() => this.close()))
			.addButton((btn) => btn.setButtonText("Entschlüsseln").setCta().onClick(submit));
	}

	onClose() {
		this.contentEl.empty();
		this.onCancel();
	}
}

class ExportModal extends Modal {
	private name: string;
	private passphrase = "";
	private submitted = false;
	private onSubmit: (name: string, passphrase: string) => void;

	constructor(app: App, defaultName: string, onSubmit: (name: string, passphrase: string) => void) {
		super(app);
		this.name = defaultName;
		this.onSubmit = onSubmit;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: "Profil exportieren" });

		let nameInputEl: HTMLInputElement;
		new Setting(contentEl).setName("Name").addText((text) => {
			nameInputEl = text.inputEl;
			text.setValue(this.name).onChange((v) => (this.name = v));
			text.inputEl.style.width = "100%";
		});

		new Setting(contentEl)
			.setName("Passwort (optional)")
			.setDesc("Verschlüsselt die Profil-Datei (AES-256-GCM). Leer lassen für unverschlüsselt.")
			.addText((text) => {
				text.inputEl.type = "password";
				text.onChange((v) => (this.passphrase = v));
			});

		const submit = () => {
			if (this.submitted || !this.name.trim()) return;
			this.submitted = true;
			this.close();
			this.onSubmit(this.name.trim(), this.passphrase);
		};

		new Setting(contentEl).addButton((btn) => btn.setButtonText("Exportieren").setCta().onClick(submit));

		contentEl.addEventListener("keydown", (e) => {
			if (e.key === "Enter") submit();
		});

		window.setTimeout(() => {
			nameInputEl.focus();
			nameInputEl.select();
		});
	}

	onClose() {
		this.contentEl.empty();
	}
}

class ImportPreviewModal extends Modal {
	private bundle: ProfileBundle;
	private onConfirm: (filteredBundle: ProfileBundle) => void;
	private includeAppSettings = true;
	private includedPlugins: Set<string>;

	constructor(app: App, bundle: ProfileBundle, onConfirm: (filteredBundle: ProfileBundle) => void) {
		super(app);
		this.bundle = bundle;
		this.onConfirm = onConfirm;
		this.includedPlugins = new Set(pluginIdsInBundle(bundle));
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: "Profil importieren" });

		const info = contentEl.createEl("p");
		info.style.whiteSpace = "pre-wrap";
		info.setText(
			`Vault: ${this.bundle.vaultName}\n` +
				`Erstellt: ${new Date(this.bundle.createdAt).toLocaleString()}\n` +
				`Dateien insgesamt: ${Object.keys(this.bundle.files).length}`
		);

		contentEl.createEl("p", {
			text: "Überschreibt die unten ausgewählten Bereiche in diesem Vault. Ein automatisches Backup des aktuellen Zustands wird vorher angelegt (falls in den Einstellungen aktiviert).",
			cls: "setting-item-description",
		});

		new Setting(contentEl)
			.setName("App-Einstellungen")
			.setDesc("Appearance, Hotkeys, Core-Plugins, Snippets, Themes, Icons, ...")
			.addToggle((toggle) =>
				toggle.setValue(this.includeAppSettings).onChange((v) => (this.includeAppSettings = v))
			);

		const pluginIds = pluginIdsInBundle(this.bundle);
		if (pluginIds.length > 0) {
			new Setting(contentEl).setName("Plugins").setHeading();
			for (const id of pluginIds) {
				new Setting(contentEl).setName(id).addToggle((toggle) =>
					toggle.setValue(true).onChange((v) => {
						if (v) this.includedPlugins.add(id);
						else this.includedPlugins.delete(id);
					})
				);
			}
		}

		new Setting(contentEl)
			.addButton((btn) => btn.setButtonText("Abbrechen").onClick(() => this.close()))
			.addButton((btn) =>
				btn
					.setButtonText("Importieren")
					.setWarning()
					.onClick(() => {
						this.close();
						this.onConfirm(this.buildFilteredBundle());
					})
			);
	}

	private buildFilteredBundle(): ProfileBundle {
		const filteredFiles: Record<string, string> = {};
		for (const [rel, data] of Object.entries(this.bundle.files)) {
			if (rel.startsWith("plugins/")) {
				const id = rel.split("/")[1];
				if (id && this.includedPlugins.has(id)) filteredFiles[rel] = data;
				continue;
			}
			if (!this.includeAppSettings) continue;
			if (rel === "community-plugins.json") {
				try {
					const text = new TextDecoder().decode(base64ToArrayBuffer(data));
					const enabled: string[] = JSON.parse(text);
					const cleaned = enabled.filter((id) => this.includedPlugins.has(id));
					filteredFiles[rel] = arrayBufferToBase64(new TextEncoder().encode(JSON.stringify(cleaned)).buffer);
				} catch (e) {
					filteredFiles[rel] = data;
				}
				continue;
			}
			filteredFiles[rel] = data;
		}
		return { ...this.bundle, files: filteredFiles };
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
		const p = contentEl.createEl("p", { text: this.message });
		p.style.whiteSpace = "pre-wrap";
		new Setting(contentEl)
			.addButton((btn) => btn.setButtonText("Abbrechen").onClick(() => this.close()))
			.addButton((btn) =>
				btn
					.setButtonText("Bestätigen")
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
				'Vault-interner Ordner, in dem Profil-Dateien gespeichert und gesucht werden. Über "Teilen" bei einem Profil per AirDrop/Files-App/etc. exportieren, im Ziel-Vault über "Datei importieren..." wieder einlesen.'
			)
			.addText((text) =>
				text.setValue(this.plugin.settings.profileFolder).onChange(async (value) => {
					this.plugin.settings.profileFolder = value.trim() || DEFAULT_SETTINGS.profileFolder;
					await this.plugin.saveSettings();
					this.display();
				})
			);

		new Setting(containerEl)
			.setName("Automatisches Backup vor Import")
			.setDesc(
				'Legt vor jedem Import automatisch ein Profil des aktuellen Zustands an (erscheint als "AutoBackup-vor-Import-..." in der Liste unten).'
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.autoBackupBeforeImport).onChange(async (value) => {
					this.plugin.settings.autoBackupBeforeImport = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl).setName("Plugins vom Export ausschließen").setHeading();
		containerEl.createEl("p", {
			text: "Ausgeschlossene Plugins landen nicht in neuen Profil-Exporten (Code + Einstellungen), und werden auch aus der Liste der zu aktivierenden Plugins entfernt. Sinnvoll z.B. für Sync-Plugins mit vault-spezifischen Zugangsdaten.",
			cls: "setting-item-description",
		});

		const manifests: Record<string, { id: string; name: string }> = (this.app as any).plugins?.manifests ?? {};
		const pluginList = Object.values(manifests).sort((a, b) => a.name.localeCompare(b.name));

		if (pluginList.length === 0) {
			containerEl.createEl("p", {
				text: "Keine Community-Plugins installiert.",
				cls: "setting-item-description",
			});
		}

		for (const manifest of pluginList) {
			new Setting(containerEl)
				.setName(manifest.name)
				.setDesc(manifest.id)
				.addToggle((toggle) =>
					toggle
						.setValue(this.plugin.settings.excludedPlugins.includes(manifest.id))
						.onChange(async (value) => {
							const set = new Set(this.plugin.settings.excludedPlugins);
							if (value) {
								set.add(manifest.id);
							} else {
								set.delete(manifest.id);
							}
							this.plugin.settings.excludedPlugins = Array.from(set);
							await this.plugin.saveSettings();
						})
				);
		}

		new Setting(containerEl).setName("Profile").setHeading();

		const listContainer = containerEl.createDiv();
		this.renderProfileList(listContainer);

		new Setting(containerEl)
			.addButton((btn) =>
				btn.setButtonText("Datei importieren...").onClick(() => this.plugin.importFromExternalFile())
			)
			.addButton((btn) =>
				btn
					.setButtonText("Neues Profil exportieren")
					.setCta()
					.onClick(() => this.plugin.promptExport(() => this.display()))
			);
	}

	private async renderProfileList(listContainer: HTMLElement) {
		const files = this.plugin.getProfileFiles();
		if (files.length === 0) {
			listContainer.createEl("p", {
				text: `Noch keine Profile in "${this.plugin.settings.profileFolder}".`,
				cls: "setting-item-description",
			});
			return;
		}

		for (const file of files) {
			const date = new Date(file.stat.mtime).toLocaleString();
			let locked = false;
			try {
				const text = await this.app.vault.cachedRead(file);
				locked = JSON.parse(text)?.encrypted === true;
			} catch (e) {
				// unreadable/non-JSON file in the profile folder, ignore
			}

			new Setting(listContainer)
				.setName(locked ? `🔒 ${file.basename}` : file.basename)
				.setDesc(`Zuletzt geändert: ${date}`)
				.addButton((btn) => btn.setButtonText("Teilen").onClick(() => this.plugin.shareProfileFile(file)))
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
	}
}
