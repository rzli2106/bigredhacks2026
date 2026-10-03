import { CORNELL_PLACES } from '../src/ui/cornell.js';

export function placeSuggestions(query, { live = false } = {}) {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const places = live ? [{ name: 'My live location' }, ...CORNELL_PLACES] : CORNELL_PLACES;
  return places.filter(place => words.every(word => place.name.toLowerCase().includes(word)));
}

/** Keep DOM focus in the input while exposing the highlighted option to AT. */
export class PlaceSearch {
  constructor(input, { live = false, onSelect = () => {} } = {}) {
    this.input = input; this.live = live; this.onSelect = onSelect;
    this.list = document.getElementById(input.getAttribute('aria-controls'));
    this.status = document.getElementById(`${this.list.id}-status`);
    this.index = -1;
    input.addEventListener('input', () => this.open());
    input.addEventListener('focus', () => this.open());
    input.addEventListener('blur', () => this.close());
    input.addEventListener('keydown', event => {
      if (event.isComposing) return;
      if (event.key === 'Escape') { event.preventDefault(); this.close(); }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault(); if (this.list.hidden) this.open();
        if (!this.matches.length) return;
        this.index = this.index < 0 ? (event.key === 'ArrowDown' ? 0 : this.matches.length - 1) :
          (this.index + (event.key === 'ArrowDown' ? 1 : -1) + this.matches.length) % this.matches.length;
        this.highlight();
      }
      if (event.key === 'Enter' && !this.list.hidden && this.index >= 0) {
        event.preventDefault(); this.select(this.matches[this.index]);
      }
    });
  }
  open() {
    this.matches = placeSuggestions(this.input.value, { live: this.live }); this.index = -1;
    this.list.replaceChildren(); this.input.removeAttribute('aria-activedescendant');
    for (const [index, place] of this.matches.entries()) {
      const option = document.createElement('li'); option.id = `${this.list.id}-${index}`;
      option.setAttribute('role', 'option'); option.setAttribute('aria-selected', 'false');
      option.textContent = place.name;
      option.addEventListener('pointerdown', event => event.preventDefault());
      option.addEventListener('click', () => this.select(place));
      this.list.append(option);
    }
    if (!this.matches.length) {
      const message = document.createElement('li'); message.className = 'search-empty';
      message.textContent = 'No campus match. Enter coordinates or drop a pin.';
      message.setAttribute('role', 'presentation'); this.list.append(message);
    }
    if (this.status) this.status.textContent = this.matches.length ? `${this.matches.length} suggestion${this.matches.length === 1 ? '' : 's'} available.` : 'No campus match. Enter coordinates or drop a pin.';
    this.list.hidden = false; this.input.setAttribute('aria-expanded', 'true');
  }
  highlight() {
    for (const [index, option] of [...this.list.children].entries()) option.setAttribute('aria-selected', String(index === this.index));
    const option = this.list.children[this.index];
    this.input.setAttribute('aria-activedescendant', option.id); option.scrollIntoView({ block: 'nearest' });
  }
  select(place) { this.input.value = place.name; this.close(); this.onSelect(place); }
  close() { if (this.status) this.status.textContent = ''; this.list.hidden = true; this.input.setAttribute('aria-expanded', 'false'); this.input.removeAttribute('aria-activedescendant'); }
}
