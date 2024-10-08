import { expectAssignable } from "tsd";
import { RedisOptions } from "iovalkey";
import { RedisCacheStoreOpts } from "..";

const clientOpts: RedisOptions = {}

expectAssignable<RedisCacheStoreOpts>({})

expectAssignable<RedisCacheStoreOpts>({
    clientOpts: {},
    maxEntries: 0,
    maxEntrySize: 0,
    tracking: true
})

expectAssignable<RedisCacheStoreOpts>({
    clientOpts: clientOpts,
    maxEntries: 0,
    maxEntrySize: 0,
    tracking: false
})
