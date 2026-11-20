import { Controller, Get } from '@nestjs/common';

/** Liveness, plus the deployed build baked into the image at build time (IAM_APP_VERSION / IAM_APP_COMMIT, see demo/Dockerfile). */
@Controller('health')
export class HealthController {
  @Get()
  health() {
    return { status: 'ok', service: 'iam-api', version: process.env.IAM_APP_VERSION ?? 'dev', commit: process.env.IAM_APP_COMMIT ?? '' };
  }
}
