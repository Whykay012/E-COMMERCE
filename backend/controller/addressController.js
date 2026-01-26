const { StatusCodes } = require("http-status-codes");
const mongoose = require("mongoose");
const Address = require("../model/address");
const BadRequestError = require("../errors/bad-request-error");
const NotFoundError = require("../errors/notFoundError");
const { logActivity } = require("../utils/activityLogger");
const axios = require("axios");

// --- Constants ---
const MAX_ADDRESSES = 10; // E-commerce standard limit to prevent abuse/data clutter

// -------------------- UTILITY FUNCTIONS --------------------

// 🔑 Helper to validate Mongo ID format (Crucial for security and preventing Mongoose errors)
const checkMongoId = (id, fieldName = "ID") => {
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
        throw new BadRequestError(`Invalid ${fieldName} format.`);
    }
};

// -------------------- AUTO-LOCATION (IP → Country/City) --------------------
// NOTE: Using a robust, self-hosted or paid geolocator is recommended for production.
const detectLocation = async (ip) => {
    if (!ip || ip === '::1' || ip === '127.0.0.1') {
        return { city: "", state: "", country: "" };
    }
    try {
        const res = await axios.get(`https://ipapi.co/${ip}/json/`);
        return {
            country: res.data.country_name || "",
            state: res.data.region || "",
            city: res.data.city || "",
            postalCode: res.data.postal || "",
        };
    } catch (err) {
        console.error(`Geolocation failed for IP ${ip}:`, err.message);
        return { city: "", state: "", country: "" };
    }
};

// --- HELPER: UNSET PREVIOUS DEFAULT ADDRESS (Requires a session) ---
/**
 * Unsets the 'isDefault' flag on all other addresses for the user.
 * @param {string} userID - The ID of the authenticated user.
 * @param {string} excludeId - The ID of the address being set as default (to exclude from unsetting).
 * @param {object} session - Mongoose session object for transactional support.
 */
const unsetPreviousDefault = async (userID, excludeId = null, session) => {
    const query = { user: userID, isDefault: true };
    if (excludeId) {
        query._id = { $ne: excludeId };
    }
    // Update all matching documents within the active transaction session
    await Address.updateMany(query, { $set: { isDefault: false } }, { session });
};

// -------------------- LIST ADDRESSES --------------------
const listAddresses = async (req, res, next) => {
    try {
        // Efficiently fetch and sort addresses, using lean() for faster reads
        const addresses = await Address.find({ user: req.user.userID })
            .select("-__v")
            .sort({
                isDefault: -1, // Default address first
                updatedAt: -1, // Most recently updated/used second
            })
            .lean(); 

        res.status(StatusCodes.OK).json({
            count: addresses.length,
            addresses,
        });
    } catch (err) {
        next(err);
    }
};

// -------------------- GET SINGLE ADDRESS --------------------
const getAddress = async (req, res, next) => {
    try {
        checkMongoId(req.params.id, "address ID");

        // Security: Ensure the user owns the address before returning it
        const address = await Address.findOne({
            _id: req.params.id,
            user: req.user.userID,
        }).lean();

        if (!address) throw new NotFoundError("Address not found or unauthorized");

        res.status(StatusCodes.OK).json({ address });
    } catch (err) {
        next(err);
    }
};

// -------------------- CREATE ADDRESS (Transactional) --------------------
const createAddress = async (req, res, next) => {
    // 🔑 Start a session for atomicity (ensures unsetting old default and creating new one are one step)
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        let data = req.body;
        const userID = req.user.userID;

        // 1. Pre-Check Address Limit
        const addressCount = await Address.countDocuments({ user: userID });
        if (addressCount >= MAX_ADDRESSES) {
            throw new BadRequestError(`You can only save up to ${MAX_ADDRESSES} addresses.`);
        }

        // 2. Auto-fill missing location data
        if (!data.country || !data.city || !data.state || !data.postalCode) {
            const location = await detectLocation(req.ip);
            data = { ...location, ...data };
        }

        // 3. Determine if it should be default
        const isFirstAddress = addressCount === 0;
        const shouldBeDefault = isFirstAddress || (data.isDefault === true);
        
        // 4. TRANSACTIONAL STEP: Unset previous default
        if (shouldBeDefault) {
            await unsetPreviousDefault(userID, null, session);
        }
        
        // 5. TRANSACTIONAL STEP: Create the new address
        // --- IMPLEMENTED REFINEMENT: Using new Address().save() for single document creation ---
        const newAddress = await new Address({ 
            ...data, 
            user: userID, 
            isDefault: shouldBeDefault 
        }).save({ session }); 

        // 6. Finalize Transaction
        await session.commitTransaction();

        // 7. Activity Logging (Outside transaction for performance)
        await logActivity({
            user: userID,
            type: "address-create",
            description: "Created new shipping address",
            meta: { addressId: newAddress._id.toString() },
            ipAddress: req.ip,
        });

        res.status(StatusCodes.CREATED).json({
            message: "Address created successfully",
            address: newAddress,
        });
    } catch (err) {
        // 8. Abort Transaction on Error (Rollback all changes)
        await session.abortTransaction();
        
        if (err.name === "ValidationError") {
            return next(new BadRequestError(err.message));
        }
        next(err);
    } finally {
        session.endSession();
    }
};

// -------------------- UPDATE ADDRESS (Transactional) --------------------
const updateAddress = async (req, res, next) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    
    try {
        const addressId = req.params.id;
        const userID = req.user.userID;
        
        checkMongoId(addressId, "address ID");

        const updateFields = req.body;

        if (Object.keys(updateFields).length === 0)
            throw new BadRequestError("No valid fields to update");

        // Force isDefault to be boolean if present
        if (updateFields.isDefault !== undefined) {
            updateFields.isDefault = Boolean(updateFields.isDefault);
        }

        // 1. TRANSACTIONAL STEP: If setting default, unset others first
        if (updateFields.isDefault === true) {
            await unsetPreviousDefault(userID, addressId, session);
        }

        // 2. TRANSACTIONAL STEP: Update the primary address
        const address = await Address.findOneAndUpdate(
            { _id: addressId, user: userID },
            { $set: updateFields },
            // Run validators on update and use the session
            { new: true, runValidators: true, session } 
        ).lean();

        if (!address) throw new NotFoundError("Address not found or unauthorized");

        await session.commitTransaction();
        
        // Activity Logging
        await logActivity({
            user: userID,
            type: "address-update",
            description: "Updated shipping address",
            meta: { addressId: addressId },
            ipAddress: req.ip,
        });

        res.status(StatusCodes.OK).json({
            message: "Address updated successfully",
            address,
        });
    } catch (err) {
        await session.abortTransaction();
        
        if (err.name === "ValidationError") {
            return next(new BadRequestError(err.message));
        }
        next(err);
    } finally {
        session.endSession();
    }
};

// -------------------- DELETE ADDRESS (Transactional) --------------------
const deleteAddress = async (req, res, next) => {
    // 🔑 Start a session for atomicity (deletion and setting new default must be one step)
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const addressId = req.params.id;
        const userID = req.user.userID;

        checkMongoId(addressId, "address ID");

        // 1. Check Count (must be done with session for guaranteed accurate count)
        const addressCount = await Address.countDocuments({ user: userID }).session(session);
        if (addressCount <= 1) {
            throw new BadRequestError("Cannot delete the last remaining address.");
        }

        // 2. TRANSACTIONAL STEP: Perform deletion
        const deleted = await Address.findOneAndDelete(
            { _id: addressId, user: userID },
            { session } // Pass session to ensure atomicity
        );
        if (!deleted) throw new NotFoundError("Address not found or unauthorized");

        // 3. TRANSACTIONAL STEP: Handle default status cleanup
        if (deleted.isDefault) {
            // Atomically select and update the oldest remaining address as the new default
            await Address.findOneAndUpdate(
                { user: userID }, 
                { $set: { isDefault: true } },
                { sort: { createdAt: 1 }, session }
            );
        }

        // 4. Finalize Transaction
        await session.commitTransaction();

        // 5. Activity Logging
        await logActivity({
            user: userID,
            type: "address-delete",
            description: "Deleted shipping address",
            meta: { addressId: addressId },
            ipAddress: req.ip,
        });

        res
            .status(StatusCodes.OK)
            .json({ message: "Address deleted successfully" });
    } catch (err) {
        // 6. Abort Transaction on Error
        await session.abortTransaction();

        next(err);
    } finally {
        session.endSession();
    }
};

module.exports = {
    listAddresses,
    getAddress,
    createAddress,
    updateAddress,
    deleteAddress,
};