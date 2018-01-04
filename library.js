(function(module) {
	"use strict";

	var User = module.parent.require('./user'),
		meta = module.parent.require('./meta'),
		db = module.parent.require('../src/database'),
		passport = module.parent.require('passport'),
		passportGoogle = require('passport-google-oauth').OAuth2Strategy,
		fs = module.parent.require('fs'),
		path = module.parent.require('path'),
		nconf = module.parent.require('nconf'),
		async = module.parent.require('async');

	var authenticationController = module.parent.require('./controllers/authentication');

	var constants = Object.freeze({
		'name': "Google",
		'admin': {
			'route': '/plugins/sso-google',
			'icon': 'fa-google-plus-square'
		}
	});

	var Google = {
		settings: undefined,
	};

	Google.init = function(data, callback) {
		var hostHelpers = require.main.require('./src/routes/helpers');
		function render(req, res, next) {
			res.render('admin/plugins/sso-google', {});
		}

		data.router.get('/admin/plugins/sso-google', data.middleware.admin.buildHeader, render);
		data.router.get('/api/admin/plugins/sso-google', render);

		hostHelpers.setupPageRoute(data.router, '/deauth/google', data.middleware, [data.middleware.requireUser], function (req, res) {
			res.render('plugins/sso-google/deauth', {
				service: "Google",
			});
		});
		data.router.post('/deauth/google', data.middleware.requireUser, function (req, res, next) {
			Google.deleteUserData({
				uid: req.user.uid,
			}, function (err) {
				if (err) {
					return next(err);
				}

				res.redirect(nconf.get('relative_path') + '/me/edit');
			});
		});

		meta.settings.get('sso-google', function (err, settings) {
			Google.settings = settings;
			callback();
		});
	}

	Google.getStrategy = function(strategies, callback) {
		if (Google.settings['id'] && Google.settings['secret']) {
			passport.use(new passportGoogle({
				clientID: Google.settings['id'],
				clientSecret: Google.settings['secret'],
				callbackURL: nconf.get('url') + '/auth/google/callback',
				passReqToCallback: true
			}, function(req, accessToken, refreshToken, profile, done) {
				if (req.hasOwnProperty('user') && req.user.hasOwnProperty('uid') && req.user.uid > 0) {
					// Save Google-specific information to the user
					User.setUserField(req.user.uid, 'gplusid', profile.id);
					db.setObjectField('gplusid:uid', profile.id, req.user.uid);
					return done(null, req.user);
				}

				Google.login(profile.id, profile.displayName, profile.name, profile.emails[0].value, profile._json.image, function(err, user) {
					if (err) {
						return done(err);
					}

					authenticationController.onSuccessfulLogin(req, user.uid);
					done(null, user);
				});
			}));

			strategies.push({
				name: 'google',
				url: '/auth/google',
				callbackURL: '/auth/google/callback',
				icon: constants.admin.icon,
				scope: 'https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/userinfo.email',
				prompt: 'select_account'
			});
		}

		callback(null, strategies);
	};

	Google.appendUserHashWhitelist = function (data, callback) {
		data.whitelist.push('gplusid');
		return setImmediate(callback, null, data);
	};

	Google.getAssociation = function(data, callback) {
		User.getUserField(data.uid, 'gplusid', function(err, gplusid) {
			if (err) {
				return callback(err, data);
			}

			if (gplusid) {
				data.associations.push({
					associated: true,
					url: 'https://plus.google.com/' + gplusid + '/posts',
					deauthUrl: nconf.get('url') + '/deauth/google',
					name: constants.name,
					icon: constants.admin.icon
				});
			} else {
				data.associations.push({
					associated: false,
					url: nconf.get('url') + '/auth/google',
					name: constants.name,
					icon: constants.admin.icon
				});
			}

			callback(null, data);
		})
	};

	Google.login = function(gplusid, handle, name, email, picture, callback) {
		Google.getUidByGoogleId(gplusid, function(err, uid) {
			if(err) {
				return callback(err);
			}

			if (uid !== null) {
				// Existing User
				callback(null, {
					uid: uid
				});
			} else {
				// New User
				var success = function(uid) {
					var autoConfirm = Google.settings['autoconfirm'] === "on" ? 1 : 0;
					User.setUserField(uid, 'email:confirmed', autoConfirm);
					if (autoConfirm) {
						db.sortedSetRemove('users:notvalidated', uid);
					}
					// Save google-specific information to the user
					User.setUserField(uid, 'gplusid', gplusid);
					db.setObjectField('gplusid:uid', gplusid, uid);

					function mergeUserData(next) {
            async.waterfall([
							async.apply(User.getUserFields, uid, ['picture', 'firstName', 'lastName', 'fullname']),
							function(info, next) {
								if (!info.picture && picture) {
									User.setUserField(uid, 'uploadedpicture', picture);
	                User.setUserField(uid, 'picture', picture);
								}
								if (!info.firstName && name && name.givenName) {
									User.setUserField(uid, 'firstName', name.givenName);
								}
								if (!info.lastName && name && name.familyName) {
									User.setUserField(uid, 'lastName', name.familyName);
								}
								if (!info.fullname && name && name.givenName && name.familyName) {
									var namestr = name.familyName + name.givenName;
									if(!/.*[\u4e00-\u9fa5]+.*$/.test(namestr)) {
										namestr = name.givenName + ' ' + name.familyName;
									}
									User.setUserField(uid, 'fullname', namestr);
								}
								next();
							}
            ], next);
          }

					mergeUserData(function(err){
						callback(err, {
							uid: uid
						});
					});
				};

				User.getUidByEmail(email, function(err, uid) {
					if(err) {
						return callback(err);
					}

					if (!uid) {
						// Abort user creation if registration via SSO is restricted
						if (Google.settings.disableRegistration === 'on') {
							return callback(new Error('[[error:sso-registration-disabled, Google]]'));
						}

						User.create({username: handle,
							email: email,
							registerFrom: 'google'}, function(err, uid) {
							if(err) {
								return callback(err);
							}

							success(uid);
						});
					} else {
						success(uid); // Existing account -- merge
					}
				});
			}
		});
	};

	Google.getUidByGoogleId = function(gplusid, callback) {
		db.getObjectField('gplusid:uid', gplusid, function(err, uid) {
			if (err) {
				return callback(err);
			}
			callback(null, uid);
		});
	};

	Google.addMenuItem = function(custom_header, callback) {
		custom_header.authentication.push({
			"route": constants.admin.route,
			"icon": constants.admin.icon,
			"name": constants.name
		});

		callback(null, custom_header);
	}

	Google.deleteUserData = function(data, callback) {
		var uid = data.uid;

		async.waterfall([
			async.apply(User.getUserField, uid, 'gplusid'),
			function(oAuthIdToDelete, next) {
				db.deleteObjectField('gplusid:uid', oAuthIdToDelete, next);
			},
			function (next) {
				db.deleteObjectField('user:' + uid, 'gplusid', next);
			},
		], function(err) {
			if (err) {
				winston.error('[sso-google] Could not remove OAuthId data for uid ' + uid + '. Error: ' + err);
				return callback(err);
			}
			callback(null, uid);
		});
	};

	module.exports = Google;
}(module));
