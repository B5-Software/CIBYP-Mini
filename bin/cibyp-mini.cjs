#!/usr/bin/env node
/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
require('../src/cli').main().catch(error => {console.error('CIBYP Mini: ' + error.message); process.exitCode = 1;});
