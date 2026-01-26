// adminUtilities.js (Admin Dashboard Reports - Fully Instrumented)

// --- External Dependencies ---
const User = require("../model/user");
const Product = require("../model/product");
const Order = require("../model/order");
const Tracing = require('../utils/tracingClient'); 
const Logger = require('../utils/logger'); 
const Metrics = require('../utils/metricsClient'); // 💡 ADDED

// Fields to include for user reports (Minimal subset for performance)
const MINIMAL_USER_FIELDS = 'name email profilePic age';

/* ===========================================================
* Admin Utility Functions (Data retrieval for Reporting)
* =========================================================== */

/**
* Retrieves products with stock at or below the given threshold.
* @param {number} threshold - The stock level threshold.
* @returns {Promise<Product[]>}
*/
const getLowStockProducts = (threshold = 20) => {
    const timer = Date.now();
    return Tracing.withSpan('AdminUtil:getLowStockProducts', async (span) => { 
        span.setAttribute('query.threshold', threshold);
        
        try {
            const products = await Product.find({ stock: { $lte: threshold } }).sort({ stock: 1 });
            const duration = Date.now() - timer;
            Metrics.timing('db.report.low_stock_fetch_ms', duration, { threshold }); // 🚀 METRIC: Timing
            span.setAttribute('result.count', products.length);
            return products;
        } catch (error) {
            Metrics.increment('db.report.error', 1, { report: 'low_stock' }); // 🚀 METRIC: Error Count
            Logger.error('LOW_STOCK_FETCH_FAIL', { err: error, threshold });
            throw error;
        }
    });
}

/**
* Aggregates and returns customers who meet VIP criteria (high spending or high order count).
* Only returns minimal user details.
* @returns {Promise<Object[]>}
* */
const getVIPCustomers = () => {
    const timer = Date.now();
    // 🚀 TRACING: Wrap the entire aggregation pipeline
    return Tracing.withSpan('AdminUtil:getVIPCustomers', async (span) => {
        span.setAttribute('query.criteria', 'spent>=1000 OR orders>=50');
        
        try {
            const results = await Order.aggregate([
                // 1. Filter for successfully paid orders
                { $match: { paymentStatus: "paid" } },
                // 2. Group by user to calculate total spent and order count
                {
                    $group: {
                        _id: "$user",
                        totalSpent: { $sum: "$totalAmount" },
                        orderCount: { $sum: 1 },
                    },
                },
                // 3. Filter for VIP criteria
                {
                    $match: {
                        $or: [{ totalSpent: { $gte: 1000 } }, { orderCount: { $gte: 50 } }],
                    },
                },
                // 4. Join with the Users collection to get user details
                {
                    $lookup: {
                        from: "users",
                        localField: "_id",
                        foreignField: "_id",
                        as: "user",
                    },
                },
                // 5. Deconstruct the user array
                { $unwind: "$user" },
                // 6. Project the final shape of the output
                {
                    $project: {
                        user: { 
                            name: 1, 
                            email: 1, 
                            _id: 1, 
                            profilePic: 1, 
                            age: 1
                        },
                        totalSpent: 1,
                        orderCount: 1,
                    },
                },
                // 7. Sort by highest total spent
                { $sort: { totalSpent: -1 } },
            ]);

            const duration = Date.now() - timer;
            Metrics.timing('db.report.vip_customers_ms', duration); // 🚀 METRIC: Timing
            span.setAttribute('result.count', results.length);
            return results;
        } catch (error) {
            Metrics.increment('db.report.error', 1, { report: 'vip_customers' }); // 🚀 METRIC: Error Count
            Logger.error('VIP_CUSTOMERS_AGG_FAIL', { err: error });
            throw error;
        }
    });
}

/**
* Retrieves VIPs who haven't placed an last order in the last 90 days (Churn Risk).
* @returns {Promise<Object[]>}
*/
const getInactiveVIPs = () => {
    const timer = Date.now();
    const limitDate = new Date();
    limitDate.setDate(limitDate.getDate() - 90); // 90 days ago

    // 🚀 TRACING: Wrap the entire aggregation pipeline
    return Tracing.withSpan('AdminUtil:getInactiveVIPs', async (span) => {
        span.setAttribute('query.inactive_days', 90);
        span.setAttribute('query.limitDate', limitDate.toISOString());

        try {
            const results = await Order.aggregate([
                // 1. Filter for paid orders
                { $match: { paymentStatus: "paid" } },
                // 2. Find the last order date for each user
                { $group: { _id: "$user", lastOrder: { $max: "$createdAt" } } },
                // 3. Filter for users whose last order was before the 90-day limit
                { $match: { lastOrder: { $lte: limitDate } } },
                // 4. Join with the Users collection
                {
                    $lookup: {
                        from: "users",
                        localField: "_id",
                        foreignField: "_id",
                        as: "user",
                    },
                },
                { $unwind: "$user" },
                // 5. Project the final output
                { 
                    $project: { 
                        user: { 
                            name: 1, 
                            email: 1, 
                            _id: 1, 
                            profilePic: 1, 
                            age: 1
                        }, 
                        lastOrder: 1 
                    } 
                },
                { $sort: { lastOrder: 1 } }, // Oldest inactive users first
            ]);

            const duration = Date.now() - timer;
            Metrics.timing('db.report.inactive_vips_ms', duration); // 🚀 METRIC: Timing
            span.setAttribute('result.count', results.length);
            return results;
        } catch (error) {
            Metrics.increment('db.report.error', 1, { report: 'inactive_vips' }); // 🚀 METRIC: Error Count
            Logger.error('INACTIVE_VIPS_AGG_FAIL', { err: error });
            throw error;
        }
    });
};

/**
* Gets users verified within the last 24 hours.
* Limits the fields returned to minimal user details.
* @returns {Promise<User[]>}
*/
const getNewVerifiedUsers = () => {
    const timer = Date.now();
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1); // 24 hours ago
    
    // 🚀 TRACING
    return Tracing.withSpan('AdminUtil:getNewVerifiedUsers', async (span) => {
        span.setAttribute('query.time_window', '24h');
        
        try {
            const users = await User.find({ isVerified: true, updatedAt: { $gte: yesterday } })
                .select(MINIMAL_USER_FIELDS)
                .sort({ updatedAt: -1 });
            
            const duration = Date.now() - timer;
            Metrics.timing('db.report.new_verified_users_ms', duration); // 🚀 METRIC: Timing
            span.setAttribute('result.count', users.length);
            return users;
        } catch (error) {
            Metrics.increment('db.report.error', 1, { report: 'new_verified_users' }); // 🚀 METRIC: Error Count
            Logger.error('NEW_USERS_FETCH_FAIL', { err: error });
            throw error;
        }
    });
};

/**
* Retrieves high value orders (e.g., above $500).
* Populates the 'user' field with minimal buyer details.
* @param {number} amount - The minimum total amount for the order.
* @returns {Promise<Order[]>}
*/
const getHighValueOrders = (amount = 500) => {
    const timer = Date.now();
    // 🚀 TRACING
    return Tracing.withSpan('AdminUtil:getHighValueOrders', async (span) => {
        span.setAttribute('query.min_amount', amount);
        
        try {
            const orders = await Order.find({ paymentStatus: "paid", totalAmount: { $gte: amount } })
                .populate('user', MINIMAL_USER_FIELDS) // Populate buyer details
                .sort({ totalAmount: -1 });
            
            const duration = Date.now() - timer;
            Metrics.timing('db.report.high_value_orders_ms', duration, { min_amount: amount }); // 🚀 METRIC: Timing
            span.setAttribute('result.count', orders.length);
            return orders;
        } catch (error) {
            Metrics.increment('db.report.error', 1, { report: 'high_value_orders' }); // 🚀 METRIC: Error Count
            Logger.error('HIGH_VALUE_ORDERS_FAIL', { err: error, amount });
            throw error;
        }
    });
};

/* ===========================================================
* Admin Dashboard Summary (Main HTTP Call Handler)
* =========================================================== */

/**
* Computes and returns the summarized metrics and detailed reports for the Admin Dashboard.
* @returns {Promise<Object>}
*/
const getDashboardSummary = async () => {
    const handlerTimer = Date.now();
    // 🚀 TRACING: Start main handler span
    return Tracing.withSpan('AdminHandler:getDashboardSummary', async (span) => {
        
        const lowStockThreshold = 20;
        const highValueThreshold = 500;
        span.setAttributes({ 
            'dashboard.lowStockThreshold': lowStockThreshold, 
            'dashboard.highValueThreshold': highValueThreshold 
        });

        // Use Promise.all to fetch all basic counts concurrently for efficiency
        const [totalUsers, admins, verifiedUsers, totalProducts] = await Tracing.withSpan('DB:FetchBasicCounts', () => 
            Promise.all([
                User.countDocuments(),
                User.countDocuments({ role: "admin" }),
                User.countDocuments({ isVerified: true }),
                Product.countDocuments(),
            ])
        );

        // Use Promise.all to fetch all detailed report data concurrently
        const [
            lowStockProducts, 
            newVerifiedUsers, 
            vips, 
            inactiveVips, 
            highValueOrders, 
            pendingOrderCount,
            totalRevenueResult
        ] = await Tracing.withSpan('DB:FetchDetailedReports', () => 
            Promise.all([
                getLowStockProducts(lowStockThreshold),
                getNewVerifiedUsers(),
                getVIPCustomers(),
                getInactiveVIPs(),
                getHighValueOrders(highValueThreshold),
                Order.countDocuments({ status: "pending" }),
                Order.aggregate([
                    { $match: { paymentStatus: "paid" } },
                    { $group: { _id: null, total: { $sum: "$totalAmount" } } },
                ]),
            ])
        );
        
        // Process results
        const lowStockCount = lowStockProducts.length;
        const totalRevenue = totalRevenueResult[0]?.total || 0;

        // Add key metrics to the main span for quick insight
        span.setAttributes({
            'metrics.totalRevenue': totalRevenue,
            'metrics.lowStockCount': lowStockCount,
            'metrics.pendingOrderCount': pendingOrderCount,
        });
        
        // 🚀 METRIC: Track overall handler duration
        const duration = Date.now() - handlerTimer;
        Metrics.timing('http.handler.dashboard_summary_ms', duration); 
        Metrics.increment('http.handler.success', 1, { endpoint: 'dashboard_summary' }); // 🚀 METRIC: Success Count

        Logger.info('DASHBOARD_SUMMARY_FETCHED', { totalUsers, totalProducts, totalRevenue, duration }); 

        return {
            totalUsers,
            admins,
            verifiedUsers,
            totalProducts,
            metrics: {
                lowStockCount,
                pendingOrderCount,
                totalRevenue,
            },
            currencyOptions: [ 
                { code: "NGN", symbol: "₦" },
                { code: "GBP", symbol: "£" },
                { code: "USD", symbol: "$" }
            ], 
            // Include detailed reports for display in dashboard widgets
            reports: {
                vips: vips,
                inactiveVips: inactiveVips,
                highValueOrders: highValueOrders,
                lowStockProducts: lowStockProducts,
                newVerifiedUsers: newVerifiedUsers,
            },
        };
    }).catch(error => {
        Metrics.increment('http.handler.error', 1, { endpoint: 'dashboard_summary' }); // 🚀 METRIC: Error in Handler
        Logger.critical('DASHBOARD_SUMMARY_CRITICAL_FAIL', { err: error });
        throw error;
    });
};

/* ===========================================================
* EXPORTS
* =========================================================== */
module.exports = {
    getDashboardSummary,
    // Exporting all underlying utilities
    getLowStockProducts,
    getVIPCustomers,
    getInactiveVIPs,
    getNewVerifiedUsers,
    getHighValueOrders,
};