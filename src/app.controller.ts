import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

@ApiTags('App')
@Controller()
export class AppController {
  constructor(private readonly config: ConfigService) {}

  @Get()
  @ApiOperation({ summary: 'Service banner / hello world' })
  getRoot() {
    return {
      name: this.config.get<string>('app.name'),
      status: 'ok',
      message: 'Finance bot is running',
    };
  }
}
