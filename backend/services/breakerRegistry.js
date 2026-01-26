const { CircuitBreaker } = require('./circuitBreaker');
const providers = ['twilio', 'aws-sns', 'sendgrid', 'postmark'];

const registry = {};

providers.forEach(p => {
    registry[p] = new CircuitBreaker(async (action) => await action(), {
        name: p,
        threshold: 50,
        windowSize: 20
    });
});

module.exports = {
    get: (name) => registry[name]
};