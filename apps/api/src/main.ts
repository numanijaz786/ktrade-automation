import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { configureApp } from './bootstrap.js';
import { AppConfig } from './config/config.module.js';

async function main(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  configureApp(app);
  const config = app.get(AppConfig);
  // Binds to 127.0.0.1 by default (docs/04 §1): only nginx / the BFF should reach the API.
  await app.listen(config.get('PORT'), config.get('HOST'));
}

void main();
