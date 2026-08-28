import { Controller, Get } from '@nestjs/common';
import { Session, UserSession } from '@thallesp/nestjs-better-auth';

@Controller('v1/users')
export class UsersController {
  @Get('me')
  me(@Session() session: UserSession) {
    return { user: session.user };
  }
}
