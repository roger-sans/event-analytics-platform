import { BigQuery } from '@google-cloud/bigquery';

export function analyticsQueryOptions(query, params, location = 'EU') {
  return {
    query,
    params: {
      ...params,
      start_date: BigQuery.date(params.start_date),
      end_date: BigQuery.date(params.end_date),
    },
    types: { start_date: 'DATE', end_date: 'DATE' },
    maximumBytesBilled: '1000000000',
    useQueryCache: true,
    location,
  };
}
