import { Controller, Get, Query } from '@nestjs/common';
import { PlacesService } from './places.service';
import { AutocompleteQueryDto } from './dto/autocomplete-query.dto';
import { PlaceDetailsQueryDto } from './dto/place-details-query.dto';

@Controller('places')
export class PlacesController {
  constructor(private readonly placesService: PlacesService) {}

  @Get('autocomplete')
  async autocomplete(@Query() query: AutocompleteQueryDto) {
    const suggestions = await this.placesService.autocomplete(query.input);
    return { suggestions };
  }

  @Get('details')
  async details(@Query() query: PlaceDetailsQueryDto) {
    const place = await this.placesService.details(query.placeId);
    return place ?? { latitude: null, longitude: null, address: '' };
  }
}
