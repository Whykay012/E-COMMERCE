// tests/reviewService.test.js
// Testing the comprehensive service logic that uses recalculateAverage and custom errors.
const { submitReview, updateReview, deleteReview, getReviewsForProduct, eventEmitter } = require('../services/reviewService');
const mongoose = require('mongoose');

// Mock specific custom errors used in the complete service file
class NotFoundError extends Error { constructor(message) { super(message); this.name = 'NotFoundError'; } }
class BadRequestError extends Error { constructor(message) { super(message); this.name = 'BadRequestError'; } }
class ForbiddenError extends Error { constructor(message) { super(message); this.name = 'ForbiddenError'; } }
jest.mock('../errors/notFoundError', () => ({ NotFoundError }));
jest.mock('../errors/bad-request-error', () => ({ BadRequestError }));
jest.mock('../errors/forbidddenError', () => ({ ForbiddenError }));


// --- MOCKING MONGOOSE MODELS AND FUNCTIONS ---
const mockReviewFindOne = jest.fn();
const mockReviewFindById = jest.fn();
const mockReviewCreate = jest.fn();
const mockReviewSave = jest.fn();
const mockReviewDeleteOne = jest.fn();
const mockReviewFind = jest.fn();
const mockReviewCountDocuments = jest.fn();

const mockProductExists = jest.fn();
const mockProductFindById = jest.fn();
const mockProductFindByIdAndUpdate = jest.fn();

// Mock the Review model
jest.mock('../model/Review', () => ({
  findOne: mockReviewFindOne,
  findById: mockReviewFindById.mockImplementation(() => ({ save: mockReviewSave, session: jest.fn() })),
  create: mockReviewCreate,
  deleteOne: mockReviewDeleteOne,
  find: mockReviewFind.mockReturnThis(), // For getReviewsForProduct
  sort: jest.fn().mockReturnThis(),
  skip: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
  populate: jest.fn().mockReturnThis(),
  lean: jest.fn().mockResolvedValue([]),
  countDocuments: mockReviewCountDocuments,
}));

// Mock the Product model
jest.mock('../model/Product', () => ({
  exists: mockProductExists,
  findById: mockProductFindById,
  findByIdAndUpdate: mockProductFindByIdAndUpdate,
}));


// Mock Mongoose transaction methods using withTransaction pattern
const mockCommit = jest.fn();
const mockAbort = jest.fn();
const mockEndSession = jest.fn();

// Mock Mongoose's startSession and withTransaction
mongoose.startSession = jest.fn().mockResolvedValue({
  withTransaction: jest.fn(async (transactionFn) => {
    let result;
    try {
      result = await transactionFn();
      mockCommit(); // Simulate commit
      return result;
    } catch (e) {
      mockAbort(); // Simulate abort
      throw e;
    } finally {
      mockEndSession();
    }
  }),
  endSession: mockEndSession,
});

// Mock the event emitter
const mockEmit = jest.fn();
eventEmitter.emit = mockEmit;


// --- Test Constants ---
const mockProductId = 'prod_123';
const mockUserId = 'user_456';
const mockReviewId = 'rev_789';
const initialRating = 5;
const newRating = 3;

// --- Helper Mock Setup ---
const mockRecalculateAverage = (initialCount, initialSum) => {
  // Mock the findById used inside recalculateAverage
  const mockProductData = { 
    ratingCount: initialCount, 
    ratingSum: initialSum, 
    product: mockProductId // Add product ID for context
  };
  mockProductFindById.mockImplementationOnce(() => ({
    session: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(mockProductData),
  }));
};

describe('ReviewService (Complete Implementation)', () => {

  beforeEach(() => {
    jest.clearAllMocks();
    // Default success mocks for transactional dependencies
    mockProductFindByIdAndUpdate.mockResolvedValue(true);
  });

  // =========================================================================
  // Test Case: submitReview
  // =========================================================================
  describe('submitReview', () => {
    const reviewArgs = { userId: mockUserId, productId: mockProductId, rating: initialRating };
    const mockNewReview = [{ _id: mockReviewId, ...reviewArgs }];

    beforeEach(() => {
      // Default success path for dependencies
      mockProductExists.mockResolvedValue({ _id: mockProductId });
      mockReviewFindOne.mockResolvedValue(null);
      mockReviewCreate.mockResolvedValue(mockNewReview);
      mockRecalculateAverage(1, initialRating); // Mock initial state for recalculate
    });

    it('should create review, update aggregates, recalculate average, commit, and emit event', async () => {
      await submitReview(reviewArgs);

      // 1. Transactional checks
      expect(mongoose.startSession).toHaveBeenCalled();
      expect(mockCommit).toHaveBeenCalled();
      expect(mockAbort).not.toHaveBeenCalled();
      expect(mockEndSession).toHaveBeenCalled();

      // 2. Aggregate update (ratingCount +1, ratingSum +rating)
      expect(mockProductFindByIdAndUpdate).toHaveBeenCalledWith(
        mockProductId,
        { $inc: { ratingCount: 1, ratingSum: initialRating } },
        expect.any(Object)
      );

      // 3. Recalculate Average (sets rating to 5.00)
      expect(mockProductFindByIdAndUpdate).toHaveBeenCalledWith(
        mockProductId,
        { $set: { rating: 5.00, reviewsCount: 1 } },
        expect.any(Object)
      );

      // 4. Event emitted after commit
      expect(mockEmit).toHaveBeenCalledWith('review.created', {
        productId: mockProductId,
        reviewId: mockNewReview[0]._id,
        rating: initialRating,
        userId: mockUserId,
      });
    });

    it('should throw NotFoundError if product does not exist and abort', async () => {
      mockProductExists.mockResolvedValue(null);

      await expect(submitReview(reviewArgs)).rejects.toThrow(NotFoundError);
      expect(mockAbort).toHaveBeenCalled();
      expect(mockEmit).not.toHaveBeenCalled();
    });
    
    it('should throw BadRequestError if review already exists and abort', async () => {
      mockReviewFindOne.mockResolvedValue({ _id: mockReviewId });

      await expect(submitReview(reviewArgs)).rejects.toThrow(BadRequestError);
      expect(mockAbort).toHaveBeenCalled();
      expect(mockEmit).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Test Case: updateReview
  // =========================================================================
  describe('updateReview', () => {
    const reviewArgs = { reviewId: mockReviewId, userId: mockUserId, rating: newRating }; // New rating is 3
    const mockReviewDocument = {
      _id: mockReviewId,
      user: mockUserId,
      product: mockProductId,
      rating: initialRating, // Old rating is 5
      save: mockReviewSave.mockImplementation(function() { this.rating = newRating; return Promise.resolve(this); }),
    };

    beforeEach(() => {
      // Mock findById to return the review document
      mockReviewFindById.mockImplementation(() => ({
        ...mockReviewDocument,
        session: jest.fn().mockResolvedValue(mockReviewDocument),
      }));
      // Mock state after delta: initial rating sum (5) - delta (2) = 3. Count is still 1.
      mockRecalculateAverage(1, newRating); 
    });

    it('should update review, calculate delta, update aggregates, commit, and emit event', async () => {
      const delta = newRating - initialRating; // 3 - 5 = -2

      await updateReview(reviewArgs);

      // 1. Transactional checks
      expect(mockCommit).toHaveBeenCalled();

      // 2. Review save check
      expect(mockReviewSave).toHaveBeenCalled();

      // 3. Aggregate update (ratingSum $inc: -2)
      expect(mockProductFindByIdAndUpdate).toHaveBeenCalledWith(
        mockProductId,
        { $inc: { ratingSum: delta } },
        expect.any(Object)
      );

      // 4. Recalculate Average (sets rating to 3.00)
      expect(mockProductFindByIdAndUpdate).toHaveBeenCalledWith(
        mockProductId,
        { $set: { rating: 3.00, reviewsCount: 1 } },
        expect.any(Object)
      );

      // 5. Event emitted after commit
      expect(mockEmit).toHaveBeenCalledWith('review.updated', expect.objectContaining({
        productId: mockProductId,
        newRating: newRating,
      }));
    });

    it('should throw NotFoundError if review does not exist and abort', async () => {
      mockReviewFindById.mockImplementation(() => ({ session: jest.fn().mockResolvedValue(null) }));

      await expect(updateReview(reviewArgs)).rejects.toThrow(NotFoundError);
      expect(mockAbort).toHaveBeenCalled();
    });

    it('should throw ForbiddenError if userId does not match review owner and abort', async () => {
      const unauthorizedUser = 'user_UNAUTHORIZED';
      const unauthorizedArgs = { reviewId: mockReviewId, userId: unauthorizedUser, rating: newRating };

      await expect(updateReview(unauthorizedArgs)).rejects.toThrow(ForbiddenError);
      expect(mockAbort).toHaveBeenCalled();
      expect(mockEmit).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Test Case: deleteReview
  // =========================================================================
  describe('deleteReview', () => {
    const reviewArgs = { reviewId: mockReviewId, userId: mockUserId };
    const mockReviewDocument = {
      _id: mockReviewId,
      user: mockUserId,
      product: mockProductId,
      rating: initialRating,
    };

    beforeEach(() => {
      mockReviewFindById.mockImplementation(() => ({
        ...mockReviewDocument,
        session: jest.fn().mockResolvedValue(mockReviewDocument),
      }));
      mockRecalculateAverage(0, 0); // Mock state after deletion (count=0, sum=0)
      mockReviewDeleteOne.mockResolvedValue({ deletedCount: 1 });
    });

    it('should delete review, update aggregates by decrement, recalculate, commit, and emit event', async () => {
      await deleteReview(reviewArgs);

      // 1. Transactional checks
      expect(mockCommit).toHaveBeenCalled();

      // 2. Aggregate update (ratingCount -1, ratingSum -rating)
      expect(mockProductFindByIdAndUpdate).toHaveBeenCalledWith(
        mockProductId,
        { $inc: { ratingCount: -1, ratingSum: -initialRating, reviewsCount: -1 } },
        expect.any(Object)
      );

      // 3. Review deletion
      expect(mockReviewDeleteOne).toHaveBeenCalledWith({ _id: mockReviewId });

      // 4. Recalculate Average (sets rating to 0.00)
      expect(mockProductFindByIdAndUpdate).toHaveBeenCalledWith(
        mockProductId,
        { $set: { rating: 0, reviewsCount: 0 } },
        expect.any(Object)
      );

      // 5. Event emitted after commit
      expect(mockEmit).toHaveBeenCalledWith('review.deleted', {
        productId: mockProductId,
        reviewId: mockReviewId,
        deletedRating: initialRating,
        userId: mockUserId,
      });
    });
    
    it('should allow deletion by admin', async () => {
      const adminArgs = { reviewId: mockReviewId, userId: 'some_other_user', isAdmin: true };
      
      await deleteReview(adminArgs);

      expect(mockCommit).toHaveBeenCalled();
      expect(mockAbort).not.toHaveBeenCalled();
    });

    it('should throw ForbiddenError if not authorized and not admin', async () => {
      const unauthorizedArgs = { reviewId: mockReviewId, userId: 'user_UNAUTHORIZED', isAdmin: false };
      
      await expect(deleteReview(unauthorizedArgs)).rejects.toThrow(ForbiddenError);
      expect(mockAbort).toHaveBeenCalled();
    });
  });

});