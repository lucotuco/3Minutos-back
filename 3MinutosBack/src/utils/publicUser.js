function publicUser(user) {
  if (!user) return null;

  return {
    id: String(user._id),
    name: user.name,
    topics: Array.isArray(user.topics) ? user.topics : [],
    deliveryTime: user.deliveryTime,
    isActive: Boolean(user.isActive),
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

module.exports = {
  publicUser,
};