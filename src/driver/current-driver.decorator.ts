import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export type DriverContext = { id: number };

export const CurrentDriver = createParamDecorator((_: unknown, ctx: ExecutionContext): DriverContext => {
  const request = ctx.switchToHttp().getRequest();
  return request.driver;
});
