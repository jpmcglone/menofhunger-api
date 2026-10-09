import { defaultedCursorPageQuerySchema } from '../../common/pagination/cursor-query.schema';

export const pagination = defaultedCursorPageQuerySchema({ maxLimit: 100, defaultLimit: 20, maxCursorLength: 500 });
