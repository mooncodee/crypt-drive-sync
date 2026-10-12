import { PluginSettingTab } from 'obsidian';
import type { Setting, SettingDefinitionItem } from 'obsidian';
import { T } from './i18n.ts';
import type CryptDriveSync from './main.ts';
import { CLIENT_SECRET_ID, PASSWORD_ID, SALT_ID } from './main.ts';

export interface Settings {
	clientId: string; // optional own OAuth client; empty = built-in
	dirNameEncrypt: boolean;
	rootPath: string;
	folder: string;
	trashDir: string;
	syncOnStart: boolean;
	intervalMin: number;
	afterEditSec: number;
	exclude: string;
	maxFileMb: number;
	maxDeletePct: number;
	confirmPlan: boolean;
	deviceName: string;
	wizardDone: boolean;
}

// Defaults: a dedicated root folder, no password2, encrypted folder names (rclone crypt defaults).
// rclone users point rootPath at their crypt remote's folder (remote = drive:encrypted → encrypted).
export const DEFAULTS: Settings = {
	clientId: '',
	dirNameEncrypt: true,
	rootPath: 'crypt-drive-sync',
	folder: '', // empty → the vault's name (set on load)
	trashDir: '_deleted',
	syncOnStart: true,
	intervalMin: 10,
	afterEditSec: 30,
	exclude: '',
	maxFileMb: 50,
	maxDeletePct: 20,
	confirmPlan: false,
	deviceName: '',
	wizardDone: false,
};

// Changing any of these points the plugin at a different remote → forget sync state.
const RESETS_STATE = new Set(['dirNameEncrypt', 'rootPath', 'folder']);

export class CryptDriveSyncSettingTab extends PluginSettingTab {
	plugin: CryptDriveSync;

	constructor(plugin: CryptDriveSync) {
		super(plugin.app, plugin);
		this.plugin = plugin;
		this.icon = 'refresh-cw';
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		await super.setControlValue(key, value);
		if (RESETS_STATE.has(key)) await this.plugin.resetState();
		if (key === 'clientId') this.plugin.logout(); // the token belongs to the old client
	}

	/** Password-style input stored in SecretStorage; saved on blur/Enter, never shown back. */
	private secretInput(s: Setting, id: string, placeholder: string) {
		const p = this.plugin;
		s.addText((t) => {
			t.inputEl.type = 'password';
			t.setPlaceholder(p.secret(id) ? T.secretIsSet : placeholder);
			t.inputEl.addEventListener('change', () => {
				const v = t.getValue();
				if (!v) return; // clearing the field never wipes a secret; "Reset setup" does that deliberately
				void p.setSecret(id, v).then(() => this.update());
			});
		});
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		const p = this.plugin;
		const s = p.settings;
		const ready = p.ready();
		return [
			{
				name: T.setupName,
				desc: T.setupDesc,
				render: (row) => {
					row.addButton((b) => {
						b.setButtonText(ready ? T.setupAgain : T.setupStart).onClick(() => p.openWizard(() => this.update()));
						if (!ready) b.setCta();
					});
				},
			},
			{
				type: 'page',
				name: T.clientPageName,
				desc: T.clientPageDesc,
				displayValue: () => (!p.hasClient() ? T.clientMissing : s.clientId.trim() ? T.clientOwn : T.clientBuiltin),
				status: () => (p.hasClient() ? null : 'warning'),
				items: [
					{
						type: 'group',
						heading: T.clientStepsHeading,
						items: T.steps.map(([name, desc, url]) => ({ name, desc, action: () => void window.open(url) })),
					},
					{
						type: 'group',
						heading: T.clientDataHeading,
						items: [
							{ name: T.clientIdName, desc: T.clientIdDesc, control: { type: 'text', key: 'clientId', placeholder: '1234…apps.googleusercontent.com' } },
							{ name: T.clientSecretName, desc: T.clientSecretDesc, render: (row) => this.secretInput(row, CLIENT_SECRET_ID, 'GOCSPX-…') },
						],
					},
				],
			},
			{
				name: T.googleName,
				render: (row) => {
					row.setDesc(p.isLoggedIn() ? T.googleOn : T.googleOff);
					row.addButton((b) => b.setButtonText(p.isLoggedIn() ? T.signOut : T.signIn).onClick(async () => {
						if (p.isLoggedIn()) p.logout();
						else await p.login();
						this.update();
					}));
				},
			},
			{
				name: T.passwordName,
				desc: (p.secret(PASSWORD_ID) ? T.passwordSet : T.passwordUnset) + T.passwordDesc,
				render: (row) => this.secretInput(row, PASSWORD_ID, T.passwordPlaceholder),
			},
			{
				name: T.folderName,
				desc: T.folderDesc(s.folder),
				control: { type: 'text', key: 'folder', validate: notEmpty },
			},
			{
				name: T.syncName,
				render: (row) => {
					row.setDesc(`${p.lastResult}\n${T.syncAuto(s.intervalMin, s.afterEditSec)}`);
					row.descEl.addClass('cds-pre-line');
					row.addButton((b) => b.setButtonText(T.syncButton).setDisabled(!ready).onClick(async () => {
						await p.sync();
						this.update();
					}));
				},
			},
			{ name: T.logName, desc: T.logDesc, action: () => p.openLog() },
			{
				type: 'page',
				name: T.advancedName,
				desc: T.advancedDesc,
				items: [
					{
						type: 'group',
						heading: T.hSync,
						items: [
							{ name: T.onStartName, desc: T.onStartDesc, control: { type: 'toggle', key: 'syncOnStart' } },
							{ name: T.intervalName, desc: T.intervalDesc, control: { type: 'number', key: 'intervalMin', min: 0, step: 1 } },
							{ name: T.afterEditName, desc: T.afterEditDesc, control: { type: 'number', key: 'afterEditSec', min: 0, step: 1 } },
							{ name: T.excludeName, desc: T.excludeDesc, control: { type: 'textarea', key: 'exclude', rows: 4, placeholder: 'Private/**\n**/*.mp4' } },
							{ name: T.maxSizeName, desc: T.maxSizeDesc, control: { type: 'number', key: 'maxFileMb', min: 1, step: 1 } },
							{ name: T.massDeleteName, desc: T.massDeleteDesc, control: { type: 'number', key: 'maxDeletePct', min: 1, max: 100, step: 1 } },
							{ name: T.confirmPlanName, desc: T.confirmPlanDesc, control: { type: 'toggle', key: 'confirmPlan' } },
							{ name: T.deviceName, desc: T.deviceDesc, control: { type: 'text', key: 'deviceName', placeholder: p.defaultDeviceName() } },
						],
					},
					{
						type: 'group',
						heading: T.hCrypt,
						items: [
							{ name: T.checkName, desc: T.checkDesc, action: () => void p.check() },
							{ name: T.saltName, desc: T.saltDesc, render: (row) => this.secretInput(row, SALT_ID, T.saltPlaceholder) },
							{ name: T.dirEncName, desc: T.dirEncDesc, control: { type: 'toggle', key: 'dirNameEncrypt' } },
							{ name: T.rootName, desc: T.rootDesc, control: { type: 'text', key: 'rootPath', validate: notEmpty } },
							{ name: T.trashName, desc: T.trashDesc, control: { type: 'text', key: 'trashDir', validate: notEmpty } },
						],
					},
					{
						type: 'group',
						heading: T.hMaintenance,
						items: [
							{ name: T.resetName, desc: T.resetDesc, action: () => void p.resetState(true) },
							{ name: T.forgetName, desc: T.forgetDesc, action: () => void p.forgetDevice(() => this.update()) },
						],
					},
				],
			},
		];
	}
}

function notEmpty(v: string): string | void {
	if (!v.trim()) return T.notEmpty;
}
