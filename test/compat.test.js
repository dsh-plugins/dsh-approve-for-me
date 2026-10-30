import {test} from 'node:test';
import assert from 'node:assert/strict';
import {supportsLegacyApproval} from '../lib/compat.js';
for(const [version,expected] of [['0.1.4',false],['0.1.5-alpha.1',true],['0.1.6-alpha.2',true],['0.1.7-alpha.2',true],['0.1.7-rc.1',true],['0.1.7-rc.2',false],['0.1.7',false],['0.2.1-rc.1',false],['0.2.2-alpha.2',false],['bad',false]])test(`approval support ${version}`,()=>assert.equal(supportsLegacyApproval(version),expected));
