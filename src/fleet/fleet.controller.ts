import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';
import { FleetService } from './fleet.service';
import { ListCarsQueryDto } from './dto/list-cars-query.dto';

@Controller()
export class FleetController {
  constructor(private readonly fleetService: FleetService) {}

  @Get('fleet/categories')
  listCategories() {
    return this.fleetService.listCategories();
  }

  @Get('fleet/branches')
  listBranches() {
    return this.fleetService.listBranchesByCity();
  }

  @Get('fleet')
  listCars(@Query() query: ListCarsQueryDto) {
    return this.fleetService.listCars(query);
  }

  @Get('fleet/:id')
  getCar(
    @Param('id', ParseIntPipe) id: number,
    @Query('branchId', new ParseIntPipe({ optional: true })) branchId?: number,
  ) {
    return this.fleetService.getCar(id, branchId);
  }
}
