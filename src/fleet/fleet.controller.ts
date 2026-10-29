import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';
import { FleetService } from './fleet.service';
import { ListCarsQueryDto } from './dto/list-cars-query.dto';
import { CarDetailQueryDto } from './dto/car-detail-query.dto';

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

  @Get('fleet/inter-city-fees')
  listInterCityFees() {
    return this.fleetService.listInterCityFees();
  }

  @Get('fleet/checkout-fees')
  listCheckoutFees() {
    return this.fleetService.listCheckoutFees();
  }

  @Get('fleet')
  listCars(@Query() query: ListCarsQueryDto) {
    return this.fleetService.listCars(query);
  }

  @Get('fleet/:id')
  getCar(@Param('id', ParseIntPipe) id: number, @Query() query: CarDetailQueryDto) {
    return this.fleetService.getCar(id, query.branchId, query.pickupAt, query.returnAt);
  }
}
