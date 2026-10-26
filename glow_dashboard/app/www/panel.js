/*
 * Home Panel in Home Assistant's sidebar (panel_custom), for phones and the HA app.
 *
 * Home Assistant loads this module and puts <home-panel-frame> in its main area. It shows the
 * panel (index.html, next to this file) in a full-size frame on the same origin, so the panel's
 * own "Sign in with Home Assistant" works inside it. On narrow screens HA hides its sidebar, so
 * a slim bar with a menu button brings the sidebar back.
 *
 * configuration.yaml (see docs/INSTALL.md):
 *
 *   panel_custom:
 *     - name: home-panel-frame
 *       url_path: home-panel
 *       sidebar_title: Home Panel
 *       sidebar_icon: mdi:view-dashboard-variant
 *       module_url: /local/home-panel/panel.js
 *
 * This file never changes between builds, so Home Assistant's 31-day cache of /local/ is
 * harmless here; the frame's index.html fetches the current build itself.
 */
const FRAME_URL = new URL('index.html', import.meta.url).href;

const MENU_ICON = '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path fill="currentColor" d="M3 6h18v2H3zm0 5h18v2H3zm0 5h18v2H3z"/></svg>';

class HomePanelFrame extends HTMLElement {
  #narrow = false;
  #title = 'Home Panel';
  #bar = null;

  /** Set by Home Assistant: true on phones, where the sidebar is hidden. */
  set narrow(value) {
    this.#narrow = !!value;
    this.#render();
  }

  /** Set by Home Assistant: the sidebar entry (its title is shown in the bar). */
  set panel(value) {
    if (value && typeof value.title === 'string' && value.title) this.#title = value.title;
    this.#render();
  }

  /** Set by Home Assistant. The panel keeps its own connection (its own sign-in), so this is unused. */
  set hass(_value) {}

  set route(_value) {}

  connectedCallback() {
    if (this.shadowRoot) return;
    const root = this.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        :host { display: flex; flex-direction: column; height: 100%; background: #0a0a0b; }
        .bar {
          flex: none; display: flex; align-items: center; gap: 4px;
          height: var(--header-height, 56px); padding: 0 8px;
          padding-top: env(safe-area-inset-top);
          background: var(--app-header-background-color, var(--primary-color, #03a9f4));
          color: var(--app-header-text-color, #fff);
          font: 500 20px/1 var(--paper-font-body1_-_font-family, system-ui, sans-serif);
        }
        .bar[hidden] { display: none; }
        button {
          width: 48px; height: 48px; display: grid; place-items: center;
          border: 0; border-radius: 50%; background: none; color: inherit; cursor: pointer;
        }
        button:focus-visible { outline: 2px solid currentColor; outline-offset: -4px; }
        .title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        iframe { flex: 1; width: 100%; min-height: 0; border: 0; display: block; }
      </style>
      <div class="bar" hidden>
        <button type="button" aria-label="Open the sidebar">${MENU_ICON}</button>
        <span class="title"></span>
      </div>
      <iframe title="Home Panel" allow="fullscreen; screen-wake-lock; autoplay" src="${FRAME_URL}"></iframe>
    `;
    this.#bar = root.querySelector('.bar');
    root.querySelector('button').addEventListener('click', () => {
      this.dispatchEvent(new Event('hass-toggle-menu', { bubbles: true, composed: true }));
    });
    this.#render();
  }

  #render() {
    if (!this.#bar) return;
    this.#bar.hidden = !this.#narrow;
    this.#bar.querySelector('.title').textContent = this.#title;
  }
}

if (!customElements.get('home-panel-frame')) customElements.define('home-panel-frame', HomePanelFrame);
