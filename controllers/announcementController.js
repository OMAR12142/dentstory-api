const Announcement = require('../models/Announcement');

// @desc    Create a new announcement (Admin only)
// @route   POST /api/admin/announcements
exports.createAnnouncement = async (req, res) => {
  try {
    let { title, content, type, severity, displayFrequency, expiresAt } = req.body;
    
    // Normalize empty date strings to null to avoid Mongoose casting errors
    if (expiresAt === '') expiresAt = undefined;

    // Deactivate others if this is a global banner (optional logic)
    // if (type === 'banner') {
    //   await Announcement.updateMany({ type: 'banner' }, { isActive: false });
    // }

    const announcement = await Announcement.create({
      title,
      content,
      type,
      displayFrequency,
      severity,
      expiresAt,
      createdBy: req.dentist._id
    });

    res.status(201).json(announcement);
  } catch (error) {
    console.error('❌ ANNOUNCEMENT ERROR:', error);
    res.status(400).json({ 
      message: error.message,
      error: error,
      details: error.errors // Mongoose validation errors
    });
  }
};

// @desc    Get all announcements (Admin only)
// @route   GET /api/admin/announcements
exports.getAllAnnouncements = async (req, res) => {
  try {
    const announcements = await Announcement.find().sort({ createdAt: -1 });
    res.json(announcements);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Toggle announcement status (Admin only)
// @route   PATCH /api/admin/announcements/:id/toggle
exports.toggleAnnouncement = async (req, res) => {
  try {
    const announcement = await Announcement.findById(req.params.id);
    if (!announcement) return res.status(404).json({ message: 'Not found' });

    announcement.isActive = !announcement.isActive;
    await announcement.save();
    res.json(announcement);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

// @desc    Delete announcement (Admin only)
// @route   DELETE /api/admin/announcements/:id
exports.deleteAnnouncement = async (req, res) => {
  try {
    const announcement = await Announcement.findByIdAndDelete(req.params.id);
    if (!announcement) return res.status(404).json({ message: 'Not found' });
    res.json({ message: 'Announcement removed' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get active announcement for users
// @route   GET /api/announcements/active
exports.getActiveAnnouncement = async (req, res) => {
  try {
    const announcement = await Announcement.findOne({ 
      isActive: true,
      $or: [
        { expiresAt: { $exists: false } },
        { expiresAt: { $gt: new Date() } }
      ]
    }).sort({ createdAt: -1 });
    
    res.json(announcement);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
