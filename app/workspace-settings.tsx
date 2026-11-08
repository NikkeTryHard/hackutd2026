'use client';

import { useEffect, useState } from 'react';

export default function WorkspaceSettings() {
  const [theme, setTheme] = useState('dark');
  const [verify, setVerify] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    setTheme(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
    setVerify(localStorage.getItem('sightline-default-verify') === 'true');
  }, []);
  return (
    <section className="ws-settings sl-panel sl-panel-pad">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          try {
            localStorage.setItem('sightline-theme', theme);
            localStorage.setItem('sightline-default-verify', String(verify));
            document.documentElement.dataset.theme = theme;
            window.dispatchEvent(new Event('sightline-theme-change'));
            setMessage('Settings saved. Run defaults apply to new runs.');
          } catch {
            setMessage('Browser storage is unavailable. Settings could not be saved.');
          }
        }}
      >
        <h2>Appearance</h2>
        <p className="sl-hint">Choose how Sightline looks on this browser.</p>
        <label className="ws-setting-field">
          Theme
          <select
            aria-label="Theme"
            value={theme}
            onChange={(event) => setTheme(event.target.value)}
          >
            <option value="dark">Dark</option>
            <option value="light">Light</option>
          </select>
        </label>
        <hr />
        <h2>New-run defaults</h2>
        <p className="sl-hint">
          You can override these when configuring a run. Existing runs are unchanged.
        </p>
        <label className="ws-setting-check">
          <input
            type="checkbox"
            checked={verify}
            onChange={(event) => setVerify(event.target.checked)}
          />
          Enable verification by default
        </label>
        <div className="ws-settings-save">
          <button className="sl-btn sl-btn--primary" type="submit">
            Save settings
          </button>
          <span role="status">{message}</span>
        </div>
      </form>
    </section>
  );
}
