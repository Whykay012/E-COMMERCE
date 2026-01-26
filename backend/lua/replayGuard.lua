-- lua/replayGuard.lua
-- KEYS[1] = replayCounterKey
-- KEYS[2] = banKey
-- ARGV[1] = windowSec
-- ARGV[2] = banThreshold
-- ARGV[3] = banTtlSec

local count = redis.call("INCR", KEYS[1])

if count == 1 then
  redis.call("EXPIRE", KEYS[1], ARGV[1])
end

if count >= tonumber(ARGV[2]) then
  redis.call("SET", KEYS[2], "1", "EX", ARGV[3])
  return { count, 1 } -- banned
end

return { count, 0 } -- not banned
