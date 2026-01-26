const crypto = require("crypto");

/**
 * Creates a compact, cluster-friendly Redis key
 * Example:
 *   input:  rl + user:123
 *   output: rl:{a9f3}:u:123
 */
function packRateLimitKey(prefix, identifier) {
    // Short stable hash (cluster slot)
    const hash = crypto
        .createHash("sha1")
        .update(identifier)
        .digest("hex")
        .slice(0, 4);

    // Shorten identifier type
    let type = "i"; // ip
    let id = identifier;

    if (identifier.startsWith("user:")) {
        type = "u";
        id = identifier.slice(5);
    } else if (identifier.startsWith("ip:")) {
        type = "i";
        id = identifier.slice(3);
    }

    return `${prefix}:{${hash}}:${type}:${id}`;
}

module.exports = { packRateLimitKey };
