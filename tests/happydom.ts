import { GlobalRegistrator } from '@happy-dom/global-registrator';
import process from 'process';

GlobalRegistrator.register({
	settings: {},
});

HTMLElement.prototype.findAll = function findAll(selector: string): HTMLElement[] {
	return Array.from(this.querySelectorAll<HTMLElement>(selector));
};

HTMLElement.prototype.empty = function empty(): void {
	this.textContent = '';
};

HTMLElement.prototype.createSpan = function createSpan(options: { text?: string; cls?: string; attr?: Record<string, string> } = {}): HTMLSpanElement {
	const span = document.createElement('span');
	if (options.text) span.textContent = options.text;
	if (options.cls) span.className = options.cls;
	if (options.attr) {
		for (const [key, value] of Object.entries(options.attr)) {
			span.setAttribute(key, value);
		}
	}
	this.appendChild(span);
	return span;
};

HTMLElement.prototype.createEl = function createEl(this: HTMLElement, tag: keyof HTMLElementTagNameMap, options: { text?: string } = {}): HTMLElement {
	const el = document.createElement(tag);
	if (options.text) el.textContent = options.text;
	this.appendChild(el);
	return el;
} as typeof HTMLElement.prototype.createEl;

HTMLElement.prototype.createDiv = function createDiv(options: { cls?: string } = {}): HTMLDivElement {
	const div = document.createElement('div');
	if (options.cls) div.className = options.cls;
	this.appendChild(div);
	return div;
};

if (process.env.LOG_TESTS === 'false') {
	console.log = () => {};
	console.debug = () => {};
}
