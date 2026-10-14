'use strict';

const A = require('./a_repeticion');
const B = require('./b_sesion');
const C = require('./c_multitopico');
const D = require('./d_carga');
const E = require('./e_hostiles');
const F = require('./f_soak');

// Cada escenario exporta { ID, NOMBRE, correr(ctx) }. correr devuelve null si no aplica (p. ej. soak en 0 min).
const ESCENARIOS = [A, B, C, D, E, F];

const porId = (id) => ESCENARIOS.find((e) => e.ID === String(id).toUpperCase()) || null;

module.exports = { ESCENARIOS, porId };
