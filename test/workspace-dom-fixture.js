'use strict';
const assert = require('node:assert/strict');
function createDom() {
    const nodes = [], listeners = new Map(), frames = new Map(); let frameId = 0;
    class Element {
        constructor(className = '', id = '') {
            this.id = id; this.className = className; this.children = []; this.dataset = {}; this.hidden = false;
            this.style = { removeProperty(name) { delete this[name]; } }; this.listeners = new Map(); this.scrollLeft = 0;
            this.rect = { left: 0, right: 300, top: 0, bottom: 200, width: 300, height: 200 };
            this.classList = { contains: name => this.className.split(' ').includes(name),
                toggle: (name, on) => { const list = this.className.split(' ').filter(x => x && x !== name); if (on) list.push(name); this.className = list.join(' '); },
                add: (...names) => names.forEach(name => this.classList.toggle(name, true)), remove: (...names) => names.forEach(name => this.classList.toggle(name, false)) };
            nodes.push(this);
        }
        appendChild(child) { return this.insertBefore(child, null); }
        append(...children) { children.forEach(child => this.appendChild(child)); }
        insertBefore(child, before) {
            if (child === before) return child;
            child.remove(); const index = before ? this.children.indexOf(before) : this.children.length;
            assert.ok(index >= 0); this.children.splice(index, 0, child); child.parentElement = this; return child;
        }
        remove() { if (this.parentElement) { const parent = this.parentElement; parent.children.splice(parent.children.indexOf(this), 1); this.parentElement = null; } }
        removeChild(child) { child.remove(); return child; }
        get firstChild() { return this.children[0] || null; }
        get nextSibling() { const parent = this.parentElement; return parent?.children[parent.children.indexOf(this) + 1] || null; }
        get nextElementSibling() { return this.nextSibling; }
        get parentNode() { return this.parentElement; }
        get childNodes() { return this.children; }
        get offsetParent() { return this.getClientRects().length ? this.parentElement : null; }
        setAttribute(key, value) { this[key] = value; }
        removeAttribute(key) { delete this[key]; }
        matches(selector) {
            if (selector === '*') return true;
            if (selector.includes(' > ')) {
                const parts = selector.split(' > '); const tail = parts.pop();
                return this.matches(tail) && this.parentElement?.matches(parts.join(' > '));
            }
            const classes = [...selector.matchAll(/\.([\w-]+)/g)].map(match => match[1]);
            if (classes.some(name => !this.classList.contains(name))) return false;
            const attr = /\[data-([\w-]+)(?:="([^"]*)")?\]/.exec(selector);
            if (attr) { const value = this.dataset[attr[1].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())]; if (value === undefined || attr[2] !== undefined && value !== attr[2]) return false; }
            if (selector.startsWith('#') && this.id !== selector.slice(1)) return false;
            return classes.length > 0 || !!attr || selector.startsWith('#');
        }
        querySelectorAll(selector) { return this.children.flatMap(child => [child, ...child.querySelectorAll('*')]).filter(child => child.matches(selector)); }
        querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
        closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
        addEventListener(name, fn) { this.listeners.set(name, [...this.listeners.get(name) || [], fn]); }
        emit(name, event = {}) { for (const fn of this.listeners.get(name) || []) fn({ preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {}, ...event }); }
        getBoundingClientRect() { return this.rect; }
        getClientRects() { let node = this; while (node) { if (node.hidden) return []; node = node.parentElement; } return [this.rect]; }
    }
    const body = new Element('body'), host = new Element('host', 'group-workspace'); body.appendChild(host);
    const document = { body, createElement: () => new Element(), getElementById: id => body.querySelectorAll('*').find(node => node.id === id) || null,
        querySelectorAll: selector => body.querySelectorAll(selector), querySelector: selector => body.querySelector(selector),
        addEventListener: (name, fn) => listeners.set(name, [...listeners.get(name) || [], fn]),
        removeEventListener: (name, fn) => listeners.set(name, (listeners.get(name) || []).filter(item => item !== fn)) };
    return { document, body, host, nodes, Element, frames,
        requestAnimationFrame: fn => { frames.set(++frameId, fn); return frameId; }, cancelAnimationFrame: id => frames.delete(id),
        emit: (name, event) => [...listeners.get(name) || []].forEach(fn => fn({ preventDefault() {}, ...event })),
        flush: () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(fn => fn()); } };
}
module.exports = { createDom };
