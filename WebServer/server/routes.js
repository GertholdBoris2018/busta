var admin = require('./admin');
var assert = require('better-assert');
var lib = require('./lib');
var database = require('./database');
var user = require('./user');
var games = require('./games');
var sendEmail = require('./sendEmail');
var stats = require('./stats');
var config = require('../config/config');


var production = process.env.NODE_ENV === 'production';

function staticPageLogged(page, loggedGoTo) {

    return function(req, res) {
        var user = req.user;
        var popup = req.popup_notice;
        if (!user){
            console.log(popup);
            return res.render(page,{popup_notice:popup});
        }
        if (loggedGoTo) return res.redirect(loggedGoTo);

        res.render(page, {
            user: user,
            popup_notice:popup
        });
    }
}
 
function contact(origin) {
    assert(typeof origin == 'string');

    return function(req, res, next) {
        var user = req.user;
        var from = req.body.email;
        var message = req.body.message;

        if (!from ) return res.render(origin, { user: user, warning: 'email required' });

        if (!message) return res.render(origin, { user: user, warning: 'message required' });

        if (user) message = 'user_id: ' + req.user.id + '\n' + message;

        sendEmail.contact(from, message, null, function(err) {
            if (err)
                return next(new Error('Error sending email: \n' + err ));

            return res.render(origin, { user: user, success: 'Thank you for writing, one of my humans will write you back very soon :) ' });
        });
    }
}

function restrict(req, res, next) {
    if (!req.user) {
       res.status(401);
       if (req.header('Accept') === 'text/plain')
          res.send('Not authorized');
       else
          res.render('401');
       return;
    } else
        next();
}

function restrictRedirectToHome(req, res, next) {
    if(!req.user) {
        res.redirect('/');
        return;
    }
    next();
}

function adminRestrict(req, res, next) {
    if (!req.user || !req.user.admin) {
        res.status(401);
        if (req.header('Accept') === 'text/plain')
            res.send('Not authorized');
        else
            res.render('401'); //Not authorized page.
        return;
    }
    next();
}

function table() {
    return function(req, res) {
        res.render('table_old', {
            user: req.user,
            table: true
        });
    }
}

function tableNew() {
    return function(req, res) {
        res.render('table_new', {
            user: req.user,
            buildConfig: config.BUILD,
            table: true
        });
    }
}

function tableDev() {
    return function(req, res) {
        if(config.PRODUCTION)
            return res.status(401);
        requestDevOtt(req.params.id, function(devOtt) {
            res.render('table_new', {
                user: req.user,
                devOtt: devOtt,
                table: true
            });
        });
    }
}
function requestDevOtt(id, callback) {
    var curl = require('curlrequest');
    var options = {
        url: 'https://www.bustabit.com/ott',
        include: true ,
        method: 'POST',
        'cookie': 'id='+id
    };

    var ott=null;
    curl.request(options, function (err, parts) {
        parts = parts.split('\r\n');
        var data = parts.pop()
            , head = parts.pop();
        ott = data.trim();
        console.log('DEV OTT: ', ott);
        callback(ott);
    });
}

module.exports = function(app) {

    app.get('/', staticPageLogged('index'));
    app.get('/register', staticPageLogged('register', '/play'));
    app.get('/login', staticPageLogged('login', '/play'));
    app.get('/reset/:recoverId', user.validateResetPassword);
    app.get('/faq', staticPageLogged('faq'));
    app.get('/contact', staticPageLogged('contact'));
    app.get('/request', restrict, user.request);
    app.get('/deposit', restrict, user.deposit);
    app.get('/withdraw', restrict, user.withdraw);
    app.get('/withdraw/request', restrict, user.withdrawRequest);
    //app.get('/support', restrict, user.contact);
    app.get('/support', restrict, user.support);
    app.get('/support/:id', restrict, user.supportEdit);
    app.get('/account', restrict, user.account);
    app.get('/security', restrict, user.security);
    app.get('/forgot-password', staticPageLogged('forgot-password'));
    app.get('/calculator', staticPageLogged('calculator'));
    app.get('/guide', staticPageLogged('guide'));


    app.get('/play-old', table());
    app.get('/play', tableNew());
    app.get('/play-id/:id', tableDev());

    app.get('/leaderboard', games.getLeaderBoard);
    app.get('/game/:id', games.show);
    app.get('/user/:name', user.profile);

    app.get('/error', function(req, res, next) { // Sometimes we redirect people to /error
      return res.render('error');
    });

    app.post('/request', restrict, user.giveawayRequest);
    app.post('/request-charging', restrict, user.requestCharging);
    app.post('/sent-reset', user.resetPasswordRecovery);
    app.post('/sent-recover', user.sendPasswordRecover);
    app.post('/reset-password', restrict, user.resetPassword);
    app.post('/edit-email', restrict, user.editEmail);
    app.post('/enable-2fa', restrict, user.enableMfa);
    app.post('/disable-2fa', restrict, user.disableMfa);
    app.post('/withdraw-request', restrict, user.handleWithdrawRequest);
    //app.post('/support', restrict, contact('support'));
    app.post('/support', restrict, user.handleSupportRequest);
    app.post('/supportApply', restrict, user.supportApply);
    app.post('/contact', contact('contact'));
    app.post('/logout', restrictRedirectToHome, user.logout);
    app.post('/login', user.login);
    app.post('/register', user.register);

    app.post('/ott', restrict, function(req, res, next) {
        var user = req.user;
        var ipAddress = req.ip;
        var userAgent = req.get('user-agent');
        assert(user);
        database.createOneTimeToken(user.id, ipAddress, userAgent, function(err, token) {
            if (err) {
                console.error('[INTERNAL_ERROR] unable to get OTT got ' + err);
                res.status(500);
                return res.send('Server internal error');
            }
            res.send(token);
        });
    });
    app.get('/stats', stats.index);


    // Admin stuff
    app.get('/admin-giveaway', adminRestrict, admin.giveAway);
    app.post('/admin-giveaway', adminRestrict, admin.giveAwayHandle);

    app.get('/admin/member-management', adminRestrict, admin.memberManagement);
    app.post('/admin/member-management', adminRestrict, admin.memberManagement);
    app.get('/admin/member-management/delete/:id', adminRestrict, admin.memberManagementDeleteUser);
    app.get('/admin/member-management/edit/:id', adminRestrict, admin.memberManagementEditUser);
    app.post('/admin/member-management/update', adminRestrict, admin.memberManagementUpdateUser);

    app.get('/admin/member-management/confirm/:id', adminRestrict, admin.memberManagementConfirmUser);
    app.get('/admin/member-management/remove/:id', adminRestrict, admin.memberManagementRemoveUser);
    app.get('/admin/member-management/cancel/:id', adminRestrict, admin.memberManagementCancelUser);

    app.get('/admin/charging-management', adminRestrict, admin.chargingManagement);
    app.post('/admin/charging-management', adminRestrict, admin.chargingManagement);
    app.get('/admin/charging-management/delete/:id', adminRestrict, admin.chargingManagementDeleteCharging);
    app.get('/admin/charging-management/edit/:id', adminRestrict, admin.chargingManagementEditCharging);
    app.get('/admin/charging-management/apply/:id/:amount/:user_id', adminRestrict, admin.chargingManagementApply);

    app.get('/admin/exchange-management', adminRestrict, admin.exchangeManagement);
    app.post('/admin/exchange-management', adminRestrict, admin.exchangeManagement);
    app.get('/admin/exchange-management/delete/:id/:amount/:user_id', adminRestrict, admin.exchangeManagementDeleteExchange);
    app.get('/admin/exchange-management/edit/:id', adminRestrict, admin.exchangeManagementEditExchange);
    app.get('/admin/exchange-management/apply/:id/:amount/:user_id', adminRestrict, admin.exchangeManagementApply);

    app.get('/admin/account-setup', adminRestrict, admin.accountSetup);
    app.post('/admin/account-setup/update', adminRestrict, admin.accountSetupUpdate);

    app.get('/admin/bank-codes', adminRestrict, admin.bankCodes);
    app.post('/admin/save-bankcode', adminRestrict, admin.saveBankCodes);
    app.get('/admin/bank-codes/confirm/:id', adminRestrict, admin.bankCodeConfirm);
    app.get('/admin/bank-codes/cancel/:id', adminRestrict, admin.bankCodeCancel);

    app.get('/admin/support', adminRestrict, admin.supportsList);
    app.get('/admin/support/:id', adminRestrict, admin.supportEdit);
    app.post('/admin/supportApply', adminRestrict, admin.supportApply);
    app.get('/admin/supportremove/:id', adminRestrict, admin.supportRemove);
    app.get('/admin/statistics', adminRestrict, admin.statistics);
    app.post('/admin/statistics', adminRestrict, admin.statistics);
    
    /*Admin page*/

    // Ajax datatable get infos
    app.post('/admin/member-list',adminRestrict, admin.getMemberList);
    app.post('/admin/charging-list',adminRestrict, admin.getChargingList);
    app.post('/admin/exchange-list',adminRestrict, admin.getExchangeList);
    app.post('/admin/black-list',adminRestrict, admin.getBlackList);
    app.post('/admin/add-block-list',adminRestrict, admin.addBlackList);
    app.post('/admin/delete-block-list',adminRestrict, admin.deleteBlackList);
    
    app.post('/admin/support-list',adminRestrict, admin.getSupportList);
    app.post('/admin/checkState', adminRestrict, admin.getStates);
    app.get('*', function(req, res) {
        res.status(404);
        res.render('404');
    });
};
