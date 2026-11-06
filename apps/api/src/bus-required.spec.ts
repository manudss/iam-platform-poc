import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Test } from '@nestjs/testing';
import { PluginsV1Module } from './plugins/v1/plugins-v1.module.js';
import { ApplicationBus } from './events/application-bus.service.js';

describe('mandatory bus architecture', () => {
  it('the API plugins module refuses startup without bus configuration', async () => {
    const keys = ['IAM_BUS_NATS_URL', 'IAM_BUS_NATS_PASSWORD', 'IAM_CORE_URL', 'IAM_CORE_ADMIN_TOKEN'];
    const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
    for (const k of keys) delete process.env[k];
    try {
      await assert.rejects(Test.createTestingModule({ imports: [PluginsV1Module] }).compile(), /event bus required/);
    } finally {
      for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    }
  });
  it('application events have no local delivery path when no bus is attached', () => {
    assert.throws(() => new ApplicationBus().emit({ type: 'user.created', tenant: 't', branch: 'main', payload: {}, at: 'now' }), /event bus required/);
  });
});
