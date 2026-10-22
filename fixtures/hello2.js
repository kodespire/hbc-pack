// The "next release" of hello.js for the delta-container fixtures: one function changed, one
// added, strings added and removed, so the string table renumbers and the code streams shift.
'use strict';
function greet(name, punctuation) { return 'hello, ' + name + (punctuation || '!'); }
function sum(values) { var total = 0; for (var i = 0; i < values.length; i++) total += values[i]; return total; }
function average(values) { return values.length ? sum(values) / values.length : 0; }
function kind(x) { switch (x) { case 0: return 'zero'; case 1: return 'one'; case 2: return 'two'; case 3: return 'three'; default: return 'many'; } }
function safe(fn) { try { return fn(); } catch (e) { return 'error: ' + e.message; } }
var config = { name: 'hbc-pack', version: 2, enabled: true, tags: ['fixture', 'hermes', 'bytecode', 'delta'], nested: { a: 1, b: [1, 2, 3, 4], c: null } };
var words = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota'];
var result = { greeting: greet(config.name, '?'), total: sum(config.nested.b), mean: average(config.nested.b), kinds: words.map(function (w, i) { return kind(i); }), safe: safe(function () { throw new Error('boom'); }) };
print(JSON.stringify(result));
