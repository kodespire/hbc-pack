// Tiny program for the hbc-pack test fixtures: a few functions, a loop, a switch,
// object and array literals, a try/catch, so every section of an HBC file is exercised.
'use strict';
function greet(name) { return 'hello, ' + name + '!'; }
function sum(values) { var total = 0; for (var i = 0; i < values.length; i++) total += values[i]; return total; }
function kind(x) { switch (x) { case 0: return 'zero'; case 1: return 'one'; case 2: return 'two'; default: return 'many'; } }
function safe(fn) { try { return fn(); } catch (e) { return 'error: ' + e.message; } }
var config = { name: 'hbc-pack', version: 1, enabled: true, tags: ['fixture', 'hermes', 'bytecode'], nested: { a: 1, b: [1, 2, 3], c: null } };
var words = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta'];
var result = { greeting: greet(config.name), total: sum(config.nested.b), kinds: words.map(function (w, i) { return kind(i); }), safe: safe(function () { throw new Error('boom'); }) };
print(JSON.stringify(result));
