// Theme handling shared by the popup and the options page.
//
// Three states: 'system' (default), 'light', 'dark'. The choice lives in
// chrome.storage.local so both pages agree and it survives a browser restart.
// The CSS does the actual work via color-scheme + light-dark(); all this module
// does is set data-theme on <html>.

const KEY = 'theme';
export const THEMES = ['system', 'light', 'dark'];
const DEFAULT = 'system';

export function applyTheme(theme) {
	document.documentElement.dataset.theme = THEMES.includes(theme) ? theme : DEFAULT;
}

export async function getTheme() {
	const stored = await chrome.storage.local.get(KEY);
	return THEMES.includes(stored[KEY]) ? stored[KEY] : DEFAULT;
}

export async function setTheme(theme) {
	const next = THEMES.includes(theme) ? theme : DEFAULT;
	await chrome.storage.local.set({ [KEY]: next });
	applyTheme(next);
	return next;
}

/**
 * Applies the stored theme and wires every [data-set-theme] button on the page.
 * Also listens for changes so the popup and options page stay in step when both
 * are open.
 */
export async function initTheme(root = document) {
	const buttons = [...root.querySelectorAll('[data-set-theme]')];

	const paint = (theme) => {
		for (const button of buttons) {
			const active = button.dataset.setTheme === theme;
			button.classList.toggle('is-active', active);
			button.setAttribute('aria-pressed', String(active));
		}
	};

	const current = await getTheme();
	applyTheme(current);
	paint(current);

	for (const button of buttons) {
		button.addEventListener('click', async () => {
			paint(await setTheme(button.dataset.setTheme));
		});
	}

	chrome.storage.onChanged.addListener((changes, area) => {
		if (area !== 'local' || !changes[KEY]) return;
		const theme = changes[KEY].newValue || DEFAULT;
		applyTheme(theme);
		paint(theme);
	});
}

/** Markup for the three-way theme switch. Same control on both pages. */
export function themeSwitchHtml() {
	return `
		<div class="theme-switch" role="group" aria-label="Theme">
			<button type="button" class="theme-btn" data-set-theme="system" title="Match system">
				<svg viewBox="0 0 24 24" aria-hidden="true">
					<rect x="2.5" y="4" width="19" height="13" rx="2" />
					<path d="M8.5 21h7M12 17v4" />
				</svg>
			</button>
			<button type="button" class="theme-btn" data-set-theme="light" title="Light">
				<svg viewBox="0 0 24 24" aria-hidden="true">
					<circle cx="12" cy="12" r="4" />
					<path d="M12 2v2.2M12 19.8V22M4.2 4.2l1.6 1.6M18.2 18.2l1.6 1.6M2 12h2.2M19.8 12H22M4.2 19.8l1.6-1.6M18.2 5.8l1.6-1.6" />
				</svg>
			</button>
			<button type="button" class="theme-btn" data-set-theme="dark" title="Dark">
				<svg viewBox="0 0 24 24" aria-hidden="true">
					<path d="M21 12.9A9 9 0 1 1 11.1 3a7 7 0 0 0 9.9 9.9z" />
				</svg>
			</button>
		</div>
	`;
}
