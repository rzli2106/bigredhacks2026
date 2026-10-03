/** A real button list works on touch browsers that do not expose datalist UI. */
export class DestinationPicker {
  constructor(input, toggle, places) {
    Object.assign(this, { input, toggle, places });
    this.menu = document.createElement('div'); this.menu.id = 'destination-suggestions';
    this.menu.className = 'destination-suggestions'; this.menu.hidden = true;
    this.menu.setAttribute('role', 'listbox'); this.menu.setAttribute('aria-label', 'Destinations'); document.body.append(this.menu);
    input.setAttribute('role', 'combobox'); input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-controls', this.menu.id); toggle.setAttribute('aria-controls', this.menu.id);
    input.addEventListener('focus', () => this.open()); input.addEventListener('input', () => this.open());
    toggle.onclick = () => this.menu.hidden ? this.open(true) : this.close();
    input.addEventListener('keydown', event => {
      if (event.key === 'Escape') this.close();
      if (event.key === 'ArrowDown') { event.preventDefault(); this.open(); this.menu.querySelector('button')?.focus(); }
    });
    this.menu.addEventListener('keydown', event => {
      const buttons = [...this.menu.querySelectorAll('button')], index = buttons.indexOf(document.activeElement);
      if (['ArrowDown','ArrowUp'].includes(event.key)) { event.preventDefault(); buttons[(index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus(); }
      if (event.key === 'Escape') { this.close(); input.focus(); this.close(); }
    });
    document.addEventListener('pointerdown', event => { if (!this.menu.contains(event.target) && event.target !== input && event.target !== toggle) this.close(); });
    window.addEventListener('resize', () => this.close());
  }
  open(all = false) {
    const query = all ? '' : this.input.value.trim().toLowerCase(); this.menu.replaceChildren();
    for (const place of this.places.filter(place => place.name.toLowerCase().includes(query))) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = place.name;
      button.setAttribute('role', 'option'); button.onclick = () => { this.input.value = place.name; this.close(); };
      this.menu.append(button);
    }
    const rect = this.input.getBoundingClientRect();
    Object.assign(this.menu.style, { left: `${rect.left}px`, top: `${rect.bottom + 4}px`, width: `${rect.width + this.toggle.offsetWidth}px`, maxHeight: `${Math.max(96, Math.min(240, window.innerHeight - rect.bottom - 12))}px` });
    this.menu.hidden = !this.menu.children.length; this.expanded(!this.menu.hidden);
  }
  expanded(value) { for (const element of [this.input, this.toggle]) element.setAttribute('aria-expanded', String(value)); }
  close() { this.menu.hidden = true; this.expanded(false); }
}
