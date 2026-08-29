import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';

import { AdminGuard } from './admin.guard.js';
import { CatalogService } from './catalog.service.js';

export const CATALOG_SERVICE = 'CATALOG_SERVICE';

function auditContext(request: any) {
  return {
    actorType: 'USER',
    actorId: request.session?.user?.id,
    actorRole: request.adminProfile?.role,
    requestId: request.res?.locals?.requestId,
    ip: request.ip,
    userAgent: request.get?.('user-agent') || request.headers?.['user-agent'],
  };
}

@UseGuards(AdminGuard)
@Controller('v1/admin/products')
export class AdminProductsController {
  constructor(@Inject(CATALOG_SERVICE) private readonly catalog: CatalogService) {}

  @Get()
  list() {
    return this.catalog.listProducts();
  }

  @Post()
  create(@Body() input: Record<string, unknown>, @Req() request: any) {
    return this.catalog.createProduct(input, auditContext(request));
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.catalog.getProduct(id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() changes: Record<string, unknown>, @Req() request: any) {
    return this.catalog.updateProduct(id, changes, auditContext(request));
  }
}

@UseGuards(AdminGuard)
@Controller('v1/admin/plans')
export class AdminPlansController {
  constructor(@Inject(CATALOG_SERVICE) private readonly catalog: CatalogService) {}

  @Get()
  list(@Query() query: Record<string, unknown>) {
    return this.catalog.listPlans(query);
  }

  @Post()
  create(@Body() input: Record<string, unknown>, @Req() request: any) {
    return this.catalog.createPlan(input, auditContext(request));
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.catalog.getPlan(id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() changes: Record<string, unknown>, @Req() request: any) {
    return this.catalog.updatePlan(id, changes, auditContext(request));
  }
}
