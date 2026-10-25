import { NestFactory, HttpAdapterHost } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { AppLogger } from './common/logger/app-logger';
import { AllExceptionsFilter } from './common/logger/all-exceptions.filter';
import { requestLogger } from './common/logger/request-logger';

async function bootstrap() {
  // Installed at creation (not via useLogger) so a startup failure — e.g. the database
  // never answering — is also logged in the structured format.
  const app = await NestFactory.create(AppModule, { logger: new AppLogger() });
  app.use(requestLogger);
  app.useGlobalFilters(new AllExceptionsFilter(app.get(HttpAdapterHost)));
  app.enableCors();
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
  const port = process.env.PORT ?? 3001;
  await app.listen(port);
  new Logger('Bootstrap').log(`rawaes-app backend listening on port ${port}`);
}

// Unhandled promise rejections arrive here too (Node turns them into uncaught
// exceptions when no 'unhandledRejection' listener exists). Keeps the default
// behaviour — the process exits and Docker restarts it — but leaves a structured
// record of why instead of a bare stderr dump.
process.on('uncaughtException', (err, origin) => {
  new Logger('Process').fatal({ msg: 'Uncaught exception — exiting', origin, err });
  process.exit(1);
});

bootstrap();
