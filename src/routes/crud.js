/**
 * Generic CRUD for simple tenant-scoped master data. There is no tenantId handling here:
 * the tenantScope plugin adds it to every query and document from the request context.
 *
 * Writes go through load → set → save() (not findOneAndUpdate) so that ALL schema
 * validators and hooks run, including the tenantRef cross-tenant checks.
 * `fields` is a whitelist, which blocks mass assignment of tenantId, isDeleted,
 * currentStock and other protected fields.
 */
const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const requireRole = require('../middleware/requireRole');
const { notFound } = require('../utils/errors');
const { pick, parsePagination } = require('../utils/helpers');

function crudRouter(Model, { fields, filterable = [], sort = { createdAt: -1 }, populate = [], writeRoles = ['manager'] }) {
  const router = express.Router();
  const label = Model.modelName;
  const canWrite = requireRole(...writeRoles);

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const { page, limit, skip } = parsePagination(req.query);
      const filter = pick(req.query, filterable);
      const [data, total] = await Promise.all([
        Model.find(filter).sort(sort).skip(skip).limit(limit).populate(populate),
        Model.countDocuments(filter),
      ]);
      res.json({ data, meta: { page, limit, total } });
    })
  );

  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const doc = await Model.findById(req.params.id).populate(populate);
      if (!doc) throw notFound(label);
      res.json({ data: doc });
    })
  );

  router.post(
    '/',
    canWrite,
    asyncHandler(async (req, res) => {
      const doc = await Model.create(pick(req.body, fields));
      res.status(201).json({ data: doc });
    })
  );

  router.patch(
    '/:id',
    canWrite,
    asyncHandler(async (req, res) => {
      const doc = await Model.findById(req.params.id);
      if (!doc) throw notFound(label);
      doc.set(pick(req.body, fields));
      await doc.save();
      res.json({ data: doc });
    })
  );

  router.delete(
    '/:id',
    canWrite,
    asyncHandler(async (req, res) => {
      const doc = await Model.findById(req.params.id);
      if (!doc) throw notFound(label);
      await doc.softDelete(req.user.id);
      res.status(204).end();
    })
  );

  return router;
}

module.exports = crudRouter;
