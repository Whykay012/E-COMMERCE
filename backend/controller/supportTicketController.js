const { StatusCodes } = require("http-status-codes");
const mongoose = require("mongoose");
const SupportTicket = require("../model/supportTicket");
const BadRequestError = require("../errors/bad-request-error");
const NotFoundError = require("../errors/notFoundError");
const { logActivity } = require("../utils/activityLogger");
const yup = require("yup");

// -------------------- CONFIG --------------------
const PRIORITY_VALUES = ["low", "medium", "high"];
const ALLOWED_FILE_TYPES = ["image/jpeg", "image/png", "application/pdf"];
const MAX_FILE_SIZE_MB = 5; // max 5MB per file
const MAX_TICKETS_PER_USER = 10; // rate-limiting per user

// -------------------- VALIDATION --------------------
const createTicketSchema = yup.object().shape({
 subject: yup.string().required("subject is required"),
 message: yup.string().required("message is required"),
 priority: yup.string().oneOf(PRIORITY_VALUES).optional(),
});

// -------------------- CREATE TICKET --------------------
const createTicket = async (req, res, next) => {
 try {
  // Rate-limit: max tickets per user
  const ticketCount = await SupportTicket.countDocuments({
   user: req.user.userID,
   deleted: false,
  });
  if (ticketCount >= MAX_TICKETS_PER_USER) {
   return res.status(StatusCodes.TOO_MANY_REQUESTS).json({
    message: "Ticket limit reached. Please resolve existing tickets first.",
   });
  }

  const { subject, message, priority } = await createTicketSchema.validate(
   req.body,
   { abortEarly: false }
  );
  const validatedPriority = priority || "medium";

  // Validate attachments
  const attachedFiles = Array.isArray(req.files)
   ? req.files
     .filter(
      (f) =>
       ALLOWED_FILE_TYPES.includes(f.mimetype) &&
       f.size <= MAX_FILE_SIZE_MB * 1024 * 1024
     )
     .map((f) => f.path)
   : [];

  const ticket = await SupportTicket.create({
   user: req.user.userID,
   subject,
   message,
   priority: validatedPriority,
   attachedFiles,
   status: "open",
   deleted: false, // soft delete flag
  });

  await logActivity({
   user: req.user.userID,
   type: "SUPPORT_TICKET",
   description: "Created support ticket",
   meta: { ticketId: ticket._id },
   ipAddress: req.ip,
  });

  res
   .status(StatusCodes.CREATED)
   .json({ message: "Support ticket created", ticket });
 } catch (err) {
  if (err.name === "ValidationError" || err.name === "AggregateError") {
   return next(new BadRequestError(err.errors.join(", ")));
  }
  next(err);
 }
};

// -------------------- LIST TICKETS --------------------
const listTickets = async (req, res, next) => {
 try {
  const page = parseInt(req.query.page) || 1;
  const limit = Math.min(parseInt(req.query.limit) || 10, 50);
  const skip = (page - 1) * limit;

    // Check for admin role
    const isAdmin = req.user.role === 'admin';

  const filter = { deleted: false };
  if (!isAdmin) {
   filter.user = req.user.userID; // Only show user's own tickets
  } else {
   // Admin can filter by user, status, or priority
   if (req.query.user) filter.user = req.query.user;
   if (req.query.status) filter.status = req.query.status;
   if (req.query.priority) filter.priority = req.query.priority;
  }

  const tickets = await SupportTicket.find(filter)
   .sort({ createdAt: -1 })
   .skip(skip)
   .limit(limit)
   .lean();

  const total = await SupportTicket.countDocuments(filter);

  res
   .status(StatusCodes.OK)
   .json({ page, limit, total, count: tickets.length, tickets });
 } catch (err) {
  next(err);
 }
};

// -------------------- GET SINGLE TICKET --------------------
const getTicket = async (req, res, next) => {
 try {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id))
   throw new BadRequestError("Invalid ticket ID");

    const isAdmin = req.user.role === 'admin';

  const filter = { _id: id, deleted: false };
  if (!isAdmin) filter.user = req.user.userID; // Non-admins can only see their own ticket

  const ticket = await SupportTicket.findOne(filter).lean();
  if (!ticket) throw new NotFoundError("Ticket not found");

  res.status(StatusCodes.OK).json({ ticket });
 } catch (err) {
  next(err);
 }
};

// -------------------- CLOSE TICKET --------------------
const closeTicket = async (req, res, next) => {
 try {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id))
   throw new BadRequestError("Invalid ticket ID");

    const isAdmin = req.user.role === 'admin';

  const filter = { _id: id, deleted: false };
  if (!isAdmin) filter.user = req.user.userID; // Non-admins can only close their own ticket

  const ticket = await SupportTicket.findOne(filter);
  if (!ticket) throw new NotFoundError("Ticket not found");

  if (ticket.status === "closed")
   return res
    .status(StatusCodes.BAD_REQUEST)
    .json({ message: "Ticket already closed" });

  ticket.status = "closed";
  await ticket.save();

  await logActivity({
   user: req.user.userID,
   type: "SUPPORT_TICKET",
   description: "Closed support ticket",
   meta: { ticketId: ticket._id },
   ipAddress: req.ip,
  });

  res.status(StatusCodes.OK).json({ message: "Ticket closed", ticket });
 } catch (err) {
  next(err);
 }
};

// -------------------- REOPEN TICKET --------------------
const reopenTicket = async (req, res, next) => {
 try {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id))
   throw new BadRequestError("Invalid ticket ID");

    const isAdmin = req.user.role === 'admin';

  const filter = { _id: id, deleted: false };
  if (!isAdmin) filter.user = req.user.userID; // Non-admins can only reopen their own ticket

  const ticket = await SupportTicket.findOne(filter);
  if (!ticket) throw new NotFoundError("Ticket not found");

  if (ticket.status === "open")
   return res
    .status(StatusCodes.BAD_REQUEST)
    .json({ message: "Ticket already open" });

  ticket.status = "open";
  await ticket.save();

  await logActivity({
   user: req.user.userID,
   type: "SUPPORT_TICKET",
   description: "Reopened support ticket",
   meta: { ticketId: ticket._id },
   ipAddress: req.ip,
  });

  res.status(StatusCodes.OK).json({ message: "Ticket reopened", ticket });
 } catch (err) {
  next(err);
 }
};

// -------------------- BULK CLOSE (ADMIN ONLY) --------------------
const bulkCloseTickets = async (req, res, next) => {
 try {
    // Check for admin role
    const isAdmin = req.user.role === 'admin';
  if (!isAdmin) throw new BadRequestError("Admin access required");
    
  const { ticketIds } = req.body;
  if (!Array.isArray(ticketIds) || ticketIds.length === 0)
   throw new BadRequestError("ticketIds array required");

  const validIds = ticketIds.filter((id) =>
   mongoose.Types.ObjectId.isValid(id)
  );

  const result = await SupportTicket.updateMany(
   { _id: { $in: validIds }, deleted: false },
   { $set: { status: "closed" } }
  );

  res
   .status(StatusCodes.OK)
   .json({ message: `Closed ${result.modifiedCount} tickets` });
 } catch (err) {
  next(err);
 }
};

// -------------------- SOFT DELETE --------------------
const deleteTicket = async (req, res, next) => {
 try {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id))
   throw new BadRequestError("Invalid ticket ID");

    const isAdmin = req.user.role === 'admin';

  const filter = { _id: id, deleted: false };
  if (!isAdmin) filter.user = req.user.userID; // Non-admins can only delete their own ticket

  const ticket = await SupportTicket.findOne(filter);
  if (!ticket) throw new NotFoundError("Ticket not found");

  ticket.deleted = true;
  await ticket.save();

  await logActivity({
   user: req.user.userID,
   type: "SUPPORT_TICKET",
   description: "Soft deleted ticket",
   meta: { ticketId: ticket._id },
   ipAddress: req.ip,
  });

  res.status(StatusCodes.OK).json({ message: "Ticket soft deleted" });
 } catch (err) {
  next(err);
 }
};

module.exports = {
 createTicket,
 listTickets,
 getTicket,
 closeTicket,
 reopenTicket,
 bulkCloseTickets,
 deleteTicket,
};