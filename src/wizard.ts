import { Modal, Notice, Setting } from 'obsidian';
import { T } from './i18n.ts';
import type CryptDriveSync from './main.ts';
import { CLIENT_SECRET_ID, PASSWORD_ID } from './main.ts';

type Step = 'intro' | 'client' | 'google' | 'location' | 'password';

/**
 * First-run setup: one decision per step, each explained, each checked before "Next"
 * ("test, then apply"). Everything here is also reachable in the settings tab.
 */
export class SetupWizard extends Modal {
	private plugin: CryptDriveSync;
	private onDone: () => void;
	private steps: Step[];
	private i = 0;
	private done = false;
	private probe?: { ok: boolean; text: string };

	constructor(plugin: CryptDriveSync, onDone: () => void) {
		super(plugin.app);
		this.plugin = plugin;
		this.onDone = onDone;
		this.steps = plugin.hasBuiltinClient() ? ['intro', 'google', 'location', 'password'] : ['intro', 'client', 'google', 'location', 'password'];
	}

	onOpen() {
		this.render();
	}

	onClose() {
		this.contentEl.empty();
		void this.plugin.markWizardDone();
		this.onDone();
	}

	private go(i: number) {
		this.i = i;
		this.render();
	}

	private text(lines: string[]) {
		for (const t of lines) this.contentEl.createEl('p', { text: t });
	}

	private nav(next: { label: string; enabled: boolean; onClick: () => unknown }) {
		const s = new Setting(this.contentEl);
		if (this.i > 0) s.addButton((b) => b.setButtonText(T.wizBack).onClick(() => this.go(this.i - 1)));
		s.addButton((b) => b.setButtonText(next.label).setCta().setDisabled(!next.enabled).onClick(() => void next.onClick()));
	}

	private render() {
		const el = this.contentEl;
		const p = this.plugin;
		el.empty();
		if (this.done) {
			this.setTitle(T.wizDone);
			this.text([p.lastResult, T.wizAuto(p.settings.intervalMin, p.settings.afterEditSec), T.wizOther]);
			new Setting(el).addButton((b) => b.setButtonText(T.close).setCta().onClick(() => this.close()));
			return;
		}
		const step = this.steps[this.i]!;
		const allTitles: Record<Step, number> = { intro: 0, client: 1, google: 2, location: 3, password: 4 };
		this.setTitle(T.wizStep(this.i + 1, this.steps.length, T.wizSteps[allTitles[step]]!));
		const next = () => this.go(this.i + 1);

		if (step === 'intro') {
			this.text(T.wizIntro);
			this.nav({ label: T.wizStart, enabled: true, onClick: next });
		} else if (step === 'client') {
			this.text([T.clientPageDesc]);
			new Setting(el).setName(T.clientStepsHeading).setHeading();
			const list = el.createEl('ol', { cls: 'cds-steps' });
			for (const [name, desc, url] of T.steps) {
				const li = list.createEl('li');
				li.createEl('a', { text: name.replace(/^\d+\.\s*/, ''), href: url });
				li.appendText(` — ${desc}`);
			}
			let id = p.settings.clientId;
			let secret = '';
			const hasSecret = !!p.secret(CLIENT_SECRET_ID);
			new Setting(el).setName(T.clientIdName).addText((t) => t.setPlaceholder('1234…apps.googleusercontent.com').setValue(id).onChange((v) => { id = v.trim(); }));
			new Setting(el).setName(T.clientSecretName).addText((t) => {
				t.inputEl.type = 'password';
				t.setPlaceholder(hasSecret ? T.wizPasswordKeep : 'GOCSPX-…');
				t.onChange((v) => { secret = v.trim(); });
			});
			this.nav({
				label: T.wizNext,
				enabled: true,
				onClick: async () => {
					await p.setClient(id, secret);
					if (p.hasClient()) next();
					else new Notice(T.clientMissingBoth);
				},
			});
		} else if (step === 'google') {
			this.text(T.wizGoogle);
			const logged = p.isLoggedIn();
			new Setting(el).setName(logged ? T.wizGoogleOn : T.wizGoogleOff).addButton((b) => {
				b.setButtonText(logged ? T.wizSignInAgain : T.wizSignIn).onClick(async () => {
					await p.login();
					this.render();
				});
				if (!logged) b.setCta();
			});
			this.nav({ label: T.wizNext, enabled: logged, onClick: next });
		} else if (step === 'location') {
			let root = p.settings.rootPath;
			let folder = p.settings.folder;
			new Setting(el).setName(T.wizRootName).setDesc(T.wizRootDesc)
				.addText((t) => t.setValue(root).onChange((v) => { root = v.trim(); }));
			new Setting(el).setName(T.wizFolderName).setDesc(T.wizFolderDesc)
				.addText((t) => t.setValue(folder).onChange((v) => { folder = v.trim(); }));
			this.nav({
				label: T.wizNext,
				enabled: true,
				onClick: async () => {
					if (!root || !folder) {
						new Notice(T.notEmpty);
						return;
					}
					await p.setLocation(root, folder);
					this.probe = undefined; // checked against the new place
					next();
				},
			});
		} else {
			this.text(T.wizPassword);
			const has = !!p.secret(PASSWORD_ID);
			let value = '';
			const status = el.createEl('p', { cls: 'cds-wizard-status' });
			if (this.probe) {
				status.setText(this.probe.text);
				status.toggleClass('mod-warning', !this.probe.ok);
			}
			new Setting(el)
				.setName(has ? T.wizPasswordSet : T.passwordName)
				.addText((t) => {
					t.inputEl.type = 'password';
					t.setPlaceholder(has ? T.wizPasswordKeep : T.passwordPlaceholder);
					t.onChange((v) => { value = v; });
				})
				.addButton((b) => b.setButtonText(T.wizSaveCheck).onClick(async () => {
					if (value) await p.setSecret(PASSWORD_ID, value);
					if (!p.secret(PASSWORD_ID)) return;
					status.setText(T.wizChecking);
					this.probe = await p.probe();
					this.render();
				}));
			if (this.probe?.ok) this.text([T.wizFirstSync]);
			this.nav({
				label: T.wizSync,
				enabled: has && !!this.probe?.ok,
				onClick: async () => {
					this.done = true;
					this.render();
					await p.sync();
					this.render();
				},
			});
		}
	}
}
