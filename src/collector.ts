import Parser from '@gregoranders/csv';

type TempModelValue = {
  value: number;
  timestamp: number;
};

type CountryState = { country: string; state: string };

type TempModel = CountryState & {
  lat: number;
  lon: number;
  values: TempModelValue[];
};

const sortByCountryAndState = (a: CountryState, b: CountryState): number => {
  const diff = a.country.localeCompare(b.country);
  if (diff === 0) {
    return a.state.localeCompare(b.state);
  }
  return diff;
};

type MappedRow = Record<string, string> & CountryState;

const mapRows = <T extends CountryState, R extends CountryState>(values: readonly T[], map: (value: T) => R): readonly R[] => {
  return values.map((value) => map(value));
};

abstract class BaseMapper<T extends CountryState> {
  public constructor() {
    this.map = this.map.bind(this);
  }

  public map<V extends MappedRow>(rows: readonly V[]): readonly T[] {
    return [...mapRows(rows, this._map)].sort(sortByCountryAndState);
  }

  protected abstract _map<V extends MappedRow>(row: V): T;
}

class ModelMapper extends BaseMapper<TempModel> {
  static _keys = {
    State: (value: string) => value,
    Country: (value: string) => value.replace(/\*/, ''),
    Lat: (value: string) => parseInt(value),
    Long: (value: string) => parseInt(value),
  } as Record<string, (value: string) => string | number>;

  protected _map<T extends MappedRow>(row: T): TempModel {
    const mapped = {
      values: [] as TempModelValue[],
    } as TempModel & Record<string, number | string>;

    Object.keys(row).forEach((key) => {
      const found = Object.keys(ModelMapper._keys).find((temp) => key.match(new RegExp(temp)));

      if (found) {
        mapped[found.toLowerCase()] = ModelMapper._keys[found](row[key]);
      } else {
        const value = parseInt(row[key] as string, 10);
        const date = new Date(key);
        const timestamp = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
        mapped.values.push({ timestamp, value });
      }
    });

    Object.freeze(mapped.values);

    return Object.freeze((mapped as unknown) as TempModel);
  }
}

type Lookup = {
  country: string;
  lat: number;
  lon: number;
  state: string;
  population: number;
  uid: number;
  code3: number;
  iso2: string;
  iso3: string;
  fips: number;
  admin2: string;
};

class LookupMapper extends BaseMapper<Lookup> {
  static _keys = {
    State: (value: string) => value,
    Country: (value: string) => value.replace(/\*/, ''),
    Lat: (value: string) => parseInt(value),
    Long: (value: string) => parseInt(value),
    Population: (value: string) => parseInt(value),
    UID: (value: string) => parseInt(value),
    iso2: (value: string) => value,
    iso3: (value: string) => value,
    code3: (value: string) => parseInt(value),
    FIPS: (value: string) => parseInt(value),
    Admin2: (value: string) => value,
  } as Record<string, (value: string) => string | number>;

  protected _map<T extends MappedRow>(row: T): Lookup {
    const temp = {} as Record<string, number | string>;

    Object.keys(row).forEach((key) => {
      Object.keys(LookupMapper._keys).forEach((tmp) => {
        if (key.match(new RegExp(tmp))) {
          temp[tmp.toLowerCase()] = LookupMapper._keys[tmp](row[key]);
        }
      });
    });

    return Object.freeze((temp as unknown) as Lookup);
  }
}

export type RowModelValue = {
  readonly confirmed: number;
  readonly deaths: number;
  readonly recovered: number;
  readonly timestamp: number;
};

export type RowModel = {
  readonly country: string;
  readonly lat: number;
  readonly lon: number;
  readonly state: string;
  readonly population: number;
  readonly values: RowModelValue[];
};

enum Type {
  CONFIRMED = 'confirmed',
  DEATHS = 'deaths',
  RECOVERED = 'recovered',
  LOOKUP = 'lookup',
}

const BASE_URL = 'https://raw.githubusercontent.com/CSSEGISandData/COVID-19/master/csse_covid_19_data/';

export const Configuration: Record<Type, string> = {
  confirmed: `${BASE_URL}csse_covid_19_time_series/time_series_covid19_confirmed_global.csv`,
  deaths: `${BASE_URL}csse_covid_19_time_series/time_series_covid19_deaths_global.csv`,
  lookup: `${BASE_URL}UID_ISO_FIPS_LookUp_Table.csv`,
  recovered: `${BASE_URL}csse_covid_19_time_series/time_series_covid19_recovered_global.csv`,
};

export class ModelCollector {
  private readonly _modelMapper = new ModelMapper();
  private readonly _lookupMapper = new LookupMapper();

  public constructor(private _configuration = Configuration) {}

  public async collect(): Promise<readonly RowModel[]> {
    const lookup = await this._fetchLookup();
    const confirmed = await this._fetchModel(Type.CONFIRMED);
    const deaths = await this._fetchModel(Type.DEATHS);
    const recovered = await this._fetchModel(Type.RECOVERED);

    return this.merge(confirmed, deaths, recovered, lookup);
  }

  private async merge(confirmed: readonly TempModel[], deaths: readonly TempModel[], recovered: readonly TempModel[], lookups: readonly Lookup[]) {
    return confirmed.map((model) => {
      const lookup = this.findCountryState(lookups, model);
      const modelDeaths = this.findCountryState(deaths, model);
      const modelRecovered = this.findCountryState(recovered, model);
      const values = model.values.map((value) => {
        return Object.freeze({
          confirmed: value.value,
          deaths: this.findSeries(value.timestamp, modelDeaths ? modelDeaths.values : []),
          recovered: this.findSeries(value.timestamp, modelRecovered ? modelRecovered.values : []),
          timestamp: value.timestamp,
        }) as RowModelValue;
      });
      return Object.freeze({
        country: model.country,
        lat: model.lat,
        lon: model.lon,
        state: model.state,
        population: lookup && lookup.population || 0,
        values: Object.freeze(values),
      }) as RowModel;
    });
  }

  private findCountryState<R extends CountryState, T extends CountryState>(models: readonly R[], model: T): R | undefined {
    return models.find((temp) => {
      let ret = temp.country.localeCompare(model.country);
      if (ret === 0) {
        if (model.state) {
          ret = model.state.localeCompare(temp.state || '');
        }
      }
      return ret === 0 ? true : false;
    });
  }

  private findSeries(timestamp: number, series: { timestamp: number; value: number }[]): number {
    const found = series.find((temp) => temp.timestamp === timestamp);
    if (found) {
      return found.value;
    }
    return 0;
  }

  private async _fetchModel(type: Type) {
    return this._fetch(type)
      .then((text) => {
        return this._parse(text);
      })
      .then((models) => {
        return this._modelMapper.map(models);
      });
  }

  private async _fetchLookup() {
    return this._fetch(Type.LOOKUP)
      .then((text) => {
        return this._parse(text);
      })
      .then((models) => {
        return this._lookupMapper.map(models);
      });
  }

  private async _parse(text: string) {
    const parser = new Parser<MappedRow>();
    parser.parse(text);
    return parser.json;
  }

  private async _fetch(type: Type) {
    const response = await fetch(this._fetchUrl(type), {
      headers: this._fetchHeaders(),
      method: 'GET',
    });

    return response.text();
  }

  private _fetchHeaders() {
    return {
      'Accept-Encoding': 'gzip, deflate, br',
    };
  }

  private _fetchUrl(type: Type) {
    return this._configuration[type];
  }
}

export default ModelCollector;

