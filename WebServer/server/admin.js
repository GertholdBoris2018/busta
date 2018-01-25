var assert = require('assert');
var async = require('async');
var database = require('./database');
var config = require('../config/config');

/**
 * The req.user.admin is inserted in the user validation middleware
 */

exports.giveAway = function(req, res) {
    var user = req.user;
    assert(user.admin);
    res.render('giveaway', { user: user });
};


exports.giveAwayHandle = function(req, res, next) {
    var user = req.user;
    assert(user.admin);

    if (config.PRODUCTION) {
        var ref = req.get('Referer');
        if (!ref) return next(new Error('Possible xsfr')); //Interesting enough to log it as an error

        if (ref.lastIndexOf('https://www.bustabit.com/admin-giveaway', 0) !== 0)
            return next(new Error('Bad referrer got: ' + ref));
    }

    var giveAwayUsers = req.body.users.split(/\s+/);
    var bits = parseFloat(req.body.bits);

    if (!Number.isFinite(bits) || bits <= 0)
        return next('Problem with bits...');

    var satoshis = Math.round(bits * 100);

    database.addRawGiveaway(giveAwayUsers, satoshis , function(err) {
        if (err) return res.redirect('/admin-giveaway?err=' + err);

        res.redirect('/admin-giveaway?m=Done');
    });
};

exports.memberManagement = function(req, res, next) {
    var user = req.user;

    var search_query_type = 'user';
    var search_query = '';

    if(req.param('search_query_type'))
        search_query_type = req.param('search_query_type');

    if(req.param('search_query'))
        search_query = req.param('search_query');

    //get all waiting request
    //getting all charings and exchange for waiting
    database.getChargingWaiting(function(err, charinglist){
        var all = [];
        all.push(charinglist);
        database.getExchangeWaiting(function(err, exchangelist){
            all.push(exchangelist);
            //get latest user
            database.getLastUser(function(err, usr){
                var lastUser = usr;
                if(search_query == ''){
                    database.getAllUsers(function(err,users) {
                        res.render('admin/member-management', { users: users, search_query_type: search_query_type, search_query: search_query, user: user ,lastUser: lastUser,sidebar: 'memberManagement',requests:all});
                    })
                } else {
                    if (search_query_type == 'user') {
                        database.getAllUsersByUsername(search_query, function (err, users) {
                            res.render('admin/member-management', {users: users, search_query_type: search_query_type, search_query: search_query, user: user,lastUser: lastUser,sidebar: 'memberManagement',requests:all});
                        })
                    } else {
                        database.getAllUsersByEmail(search_query, function (err, users) {
                            res.render('admin/member-management', {users: users, search_query_type: search_query_type, search_query: search_query, user: user,lastUser: lastUser,sidebar: 'memberManagement',requests:all});
                        })
                    }
                }
            });
            
        });
    });
    
}

exports.memberManagementDeleteUser = function(req, res, next) {
    var userId = req.params.id;

    database.deleteUser(userId, function(err) {
        res.redirect('/admin/member-management');
    })
}

exports.memberManagementConfirmUser = function(req, res, next) {
    var userId = req.params.id;

    database.confirmUser(userId, function(err) {
        //get username by id
        database.getUserFromId(userId, function(err, user) {
            var username = user.username;
            //global.chat_confirm_socket.emit('news_chat_approve'+userId, username);
            if(global.clients[username])
            global.socketio.sockets.connected[global.clients[username].socket].emit('news_chat_approve'+userId,username);
            res.redirect('/admin/member-management');
        })
        
        //global.socket.emit('chatConfirmd','success');
        
    })
}

exports.memberManagementRemoveUser = function(req, res, next) {
    var userId = req.params.id;

    database.removeUser(userId, function(err) {
        //get username by id
        database.getUserFromId(userId, function(err, user) {
            var username = user.username;
            //global.chat_confirm_socket.emit('news_chat_decline'+userId, username);
            if(global.clients[username])
            global.socketio.sockets.connected[global.clients[username].socket].emit('news_chat_decline'+userId,username);
            res.redirect('/admin/member-management');
        })
        
    })
}

exports.memberManagementCancelUser = function(req, res, next) {
    var userId = req.params.id;

    database.cancelUser(userId, function(err) {
        //get username by id
        database.getUserFromId(userId, function(err, user) {
            var username = user.username;
            //global.chat_confirm_socket.emit('news_chat_decline'+userId, username);
            if(global.clients[username])
            global.socketio.sockets.connected[global.clients[username].socket].emit('news_chat_decline'+userId,username);
            res.redirect('/admin/member-management');
        })
    })
}

exports.chargingManagementDeleteCharging = function(req, res, next) {
    var chargingId = req.params.id;

    database.deleteCharging(chargingId, function(err) {
        res.redirect('/admin/charging-management');
    })
}

exports.exchangeManagementDeleteExchange = function(req, res, next) {
    var exchangeId = req.params.id;
    var userId = req.params.user_id;
    var exchangeAmount = req.params.amount;

    database.deleteExchange(exchangeId, function(err) {
        database.getUserFromId(userId, function(err, user) {
            var updatedBalance = parseFloat(user.balance_satoshis) + parseFloat(exchangeAmount);

            database.updateUserBalance(userId, updatedBalance, function(err) {
                res.redirect('/admin/exchange-management');
            })
        })

    })
}

exports.memberManagementEditUser = function(req, res, next) {
    var user = req.user;
    var userId = req.params.id;

    database.getUserFromId(userId, function(err, edit_user) {
        console.log(err);
        console.log(edit_user);
        database.getChargingWaiting(function(err, charinglist) {
            var all = [];
            all.push(charinglist);
            database.getExchangeWaiting(function (err, exchangelist) {
                all.push(exchangelist);
                database.getLastUser(function(err, usr){
                    var lastUser = usr;
                    res.render('admin/member-edit', { edit_user: edit_user , user: user, lastUser: lastUser,sidebar: 'memberManagement',requests:all});
                });
            })
        })
    })
}

exports.accountSetup = function(req, res, next) {
    var userId = req.user.id;
    var popupLayout = req.user.popup_notice;
    database.getUserFromId(userId, function(err, user) {
        user.popup_notice = popupLayout;
        //getting all charings and exchange for waiting
        database.getChargingWaiting(function(err, charinglist){
            var all = [];
            all.push(charinglist);
            database.getExchangeWaiting(function(err, exchangelist){
                all.push(exchangelist);
                database.getLastUser(function(err, usr){
                    var lastUser = usr;
                    res.render('admin/account-setup', { user: user ,lastUser: lastUser,sidebar: 'accountSetup',requests:all});                    
                });
            });
        });
        
    })
}

exports.chargingManagementEditCharging = function(req, res, next) {
    var chargingId = req.params.id;

    database.getChargingFromId(chargingId, function(err, charging) {
        res.render('admin/charging-edit', { charging: charging });
    })
}

exports.exchangeManagementEditExchange = function(req, res, next) {
    var exchangeId = req.params.id;

    database.getExchangeFromId(exchangeId, function(err, exchange) {
        res.render('admin/exchange-edit', { exchange: exchange });
    })
}

exports.memberManagementUpdateUser = function(req, res, next) {
    var userId = req.body.id;
    var bankName = req.body.bank_name;
    var accountNumber = req.body.account_number;
    var bankAccountName = req.body.bank_account_name;
    var mobilePhoneNumber = req.body.mobile_phone_number;
    var balance = req.body.balance;
    var password = req.body.password;
    // var email = req.body.email;
    database.updateUser(userId , bankName, accountNumber, bankAccountName, mobilePhoneNumber, balance,password, function(err, user) {
        res.redirect('/admin/member-management');
    })
}

exports.accountSetupUpdate = function(req, res, next) {
    var userId = req.body.id;
    var bankName = req.body.bank_name;
    var accountNumber = req.body.account_number;
    var bankAccountName = req.body.bank_account_name;
    var mobilePhoneNumber = req.body.mobile_phone_number;
    var balance = req.body.balance;
    //getting all charings and exchange for waiting
    var userId = req.user.id;
    
        database.getChargingWaiting(function(err, charinglist){
            var all = [];
            all.push(charinglist);
            database.getExchangeWaiting(function(err, exchangelist){
                all.push(exchangelist);
                database.getLastUser(function(err, usr){
                    var lastUser = usr;
                    database.updateUser(userId, bankName, accountNumber, bankAccountName, mobilePhoneNumber,balance,'*****', function(err, usr) {
                        database.getUserFromId(userId, function(err, user) {
                            //if Layer Notice Exist
                            var noticement = req.body.noticement;
                                database.setPopUpNotice(noticement, function(err,notice){

                                });
                            user.popup_notice = noticement;
                            res.render('admin/account-setup', { user: user ,lastUser: lastUser,sidebar: 'accountSetup',requests:all}); 
                        })
                    })               
                });
            });
        });
        
    
    
    
}

exports.chargingManagementApply = function(req, res, next) {
    var chargingId = req.params.id;
    var chargingAmount = req.params.amount;
    var userId = req.params.user_id;

    database.isChargedOnce(userId, function(err, isChargedOnce){
        if(isChargedOnce == 'Yes') {

            database.getUserFromId(userId, function (err, user) {
                var updatedBalance = parseFloat(user.balance_satoshis) + parseFloat(chargingAmount);

                database.updateUserBalance(userId, updatedBalance, function (err) {
                    database.confirmCharging(chargingId, function (err) {
                        res.redirect('/admin/charging-management');
                    })
                })
            })
        } else {
            var updatedBalance = parseFloat(chargingAmount);

            database.updateUserBalance(userId, updatedBalance, function (err) {
                database.confirmCharging(chargingId, function (err) {
                    res.redirect('/admin/charging-management');
                })
            })
        }
    })
}

exports.exchangeManagementApply = function(req, res, next) {
    var exchangeId = req.params.id;
    var exchangeAmount = req.params.amount;
    var userId = req.params.user_id;

    database.getUserFromId(userId, function(err, user) {
        var updatedBalance = parseFloat(user.balance_satoshis) - parseFloat(exchangeAmount);

        //database.updateUserBalance(userId, updatedBalance, function(err) {
            database.confirmExchange(exchangeId, function(err) {
                res.redirect('/admin/exchange-management');
            })
        //})
    })
}

exports.chargingManagement = function(req, res, next) {
    var user = req.user;

    var d = new Date(),
        month = '' + (d.getMonth() + 1),
        day = '' + d.getDate(),
        year = d.getFullYear();

    if (month.length < 2) month = '0' + month;
    if (day.length < 2) day = '0' + day;

    var cur_day = [year, month, day].join('-');
    var search_date = cur_day;
    
    /*if(req.param('query')) {
        var username = req.param('query');

        database.getAllChargingByUsername(username, function(err,chargings) {
            res.render('admin/charging-management', { chargings: chargings, user:user });
        })
    } else {
        database.getAllCharging(function(err, chargings) {
            res.render('admin/charging-management', { chargings: chargings, user:user });
        })
    }*/
    
    if(req.param('query_date'))
        search_date = req.param('query_date');

    database.getAllChargingByDate(search_date, function(err, chargings) {
        var chargings_length = 0 ;
        if (chargings !== undefined)
            chargings_length = chargings.length;
        var total_charging = 0;
        if(chargings_length > 0){
            for(var i=0; i<chargings.length; i++){
                if(chargings[i].confirmed == 0){
                    total_charging += parseFloat(chargings[i].amount);
                }
            }
        }
        //getting all charings and exchange for waiting
        database.getChargingWaiting(function(err, charinglist){
            var all = [];
            all.push(charinglist);
            database.getExchangeWaiting(function(err, exchangelist){
                all.push(exchangelist);
                database.getLastUser(function(err, usr){
                    var lastUser = usr;
                    res.render('admin/charging-management', { chargings: chargings, chargings_length:chargings_length, total_chargings:total_charging, search_date:search_date, user:user,lastUser: lastUser, sidebar:'chargeManagement' ,requests:all});
                });
                
            });
        });
        
    })
}

exports.exchangeManagement = function(req, res, next) {
    var user = req.user;

    var d = new Date(),
        month = '' + (d.getMonth() + 1),
        day = '' + d.getDate(),
        year = d.getFullYear();

    if (month.length < 2) month = '0' + month;
    if (day.length < 2) day = '0' + day;

    var cur_day = [year, month, day].join('-');
    var search_date = cur_day;

    /*if(req.param('query')) {
        var username = req.param('query');

        database.getAllExchangeByUsername(username, function(err,exchanges) {
            res.render('admin/exchange-management', { exchanges: exchanges, user: user });
        })
    } else {
        database.getAllExchange(function(err, exchanges) {
            res.render('admin/exchange-management', { exchanges: exchanges, user: user });
        })
    }*/

    if(req.param('query_date'))
        search_date = req.param('query_date');

    database.getAllExchangeByDate(search_date, function(err, exchanges) {
        var exchanges_length = 0 ;
        if (exchanges !== undefined)
            exchanges_length = exchanges.length;
        var total_exchanges = 0;
        if(exchanges_length > 0){
            for(var i=0; i<exchanges.length; i++){
                if(exchanges[i].confirmed == 0){
                    total_exchanges += parseFloat(exchanges[i].amount);
                }
            }
        }
        //getting all charings and exchange for waiting
        database.getChargingWaiting(function(err, charinglist){
            var all = [];
            all.push(charinglist);
            database.getExchangeWaiting(function(err, exchangelist){
                all.push(exchangelist);
                //get latest user
                database.getLastUser(function(err, usr){
                    var lastUser = usr;
                    res.render('admin/exchange-management', { exchanges: exchanges, exchanges_length: exchanges_length, total_exchanges:total_exchanges, search_date:search_date, user:user ,lastUser: lastUser,sidebar:'exchangeManagement',requests:all});
                });
                
            });
        });
        
    })
}

exports.bankCodes = function(req, res, next) {
    var user = req.user;

    database.getAllBankCodes(function(err, bankcodes) {
        var bankcodes_length = 0 ;
        if (bankcodes !== undefined)
            bankcodes_length = bankcodes.length;

        var already_confirmed_length = 0;
        if(bankcodes_length > 0){
            for(var i=0; i<bankcodes.length; i++){
                if(bankcodes[i].confirmed == '1')
                    already_confirmed_length = already_confirmed_length + 1;
            }
        }
        //getting all charings and exchange for waiting
        database.getChargingWaiting(function(err, charinglist){
            var all = [];
            all.push(charinglist);
            database.getExchangeWaiting(function(err, exchangelist){
                all.push(exchangelist);
                database.getLastUser(function(err, usr){
                    var lastUser = usr;
                    res.render('admin/bank-codes', { bankcodes: bankcodes, bankcodes_length: bankcodes_length, already_confirmed_length: already_confirmed_length, user: user ,lastUser: lastUser,sidebar:'bankCode',requests:all});

                });
            });
        });
        
    })
}

exports.supportsList = function(req, res, next) {
    var user = req.user;

    //getting all charings and exchange for waiting
    database.getChargingWaiting(function(err, charinglist){
        var all = [];
        all.push(charinglist);
        database.getExchangeWaiting(function(err, exchangelist){
            all.push(exchangelist);
            database.getLastUser(function(err, usr){
                var lastUser = usr;
                res.render('admin/supports', {  user: user , lastUser: lastUser, sidebar:'supports',requests:all});

            });
        });
    });
}

exports.supportEdit = function (req, res, next) {
    var supportId = req.params.id;

    database.getSupport(supportId, function(err, supports) {
        if (err) {
            return next(new Error('Unable to get user support: \n' + err));
        }
        //getting all charings and exchange for waiting
        database.getChargingWaiting(function(err, charinglist){
            var all = [];
            all.push(charinglist);
            database.getExchangeWaiting(function(err, exchangelist){
                all.push(exchangelist);
                database.getLastUser(function(err, usr){
                    var lastUser = usr;
                    res.render('admin/support-edit', { user: req.user, supports: supports, supportId: supportId, lastUser: lastUser, sidebar:'supports',requests:all});
                });
            });
        });
    })
}
exports.supportRemove = function (req, res, next) {
    var supportId = req.params.id;

    database.deleteSupport(supportId, function(err) {
        if (err) {
            return next(new Error('Unable to get user support: \n' + err));
        }
        res.redirect('/admin/support');
    })
}


exports.supportApply = function (req, res, next) {
    var supportId = req.body.supportId;
    var message= req.body.reply;

    database.supportApply(supportId, message, function(err) {
        res.redirect('/admin/support/'+supportId);
    })
}

exports.getMemberList = function(req, res, next){
    var start = 0;
    var amount = 5;
    var sStart = req.body.start;
    var sAmount = req.body.length;
    var search = req.body.search;

    if(sStart && sStart.length > 0){
        start = parseInt(sStart,10);
        if(start < 0){
            start = 0;
        }
    }
    if(sAmount && sAmount.length > 0){
        amount = parseInt(sAmount,10);
    }
    var condition = [];
    condition['search'] = search['value'];
    database.getMemberList(start,amount,condition,function(err, list){
        res.json({
            'recordsTotal': list['total'],
            'recordsFiltered': list['sub'],
            'data': list['members']
        });
    });
    
}
exports.getSupportList = function(req, res, next){
    var start = 0;
    var amount = 5;
    var sStart = req.body.start;
    var sAmount = req.body.length;
    var search = req.body.search;

    if(sStart && sStart.length > 0){
        start = parseInt(sStart,10);
        if(start < 0){
            start = 0;
        }
    }
    if(sAmount && sAmount.length > 0){
        amount = parseInt(sAmount,10);
    }
    var condition = [];
    condition['search'] = search['value'];
    database.getSupportList(start,amount,condition,function(err, list){
        res.json({
            'recordsTotal': list['total'],
            'recordsFiltered': list['sub'],
            'data': list['supports'],
            'sql': list['sql']
        });
    });
}
exports.getStates = function(req, res, next){
    //get last user
    database.getUnconfirmedUser(function(err, usrs){
        //get exchanging and charging list
        database.getChargingWaiting(function(err, charinglist){
            database.getExchangeWaiting(function(err, exchangelist){
                database.getSupports(function(err, supports){
                    res.json({
                        'lastUser' : usrs,
                        'chargings' : charinglist,
                        'exchangelist' : exchangelist,
                        'supports' : supports
                    });
                });
                   
            });
        });

        
    });
    
}

exports.getChargingList = function(req, res, next){
    var start = 0;
    var amount = 5;
    var sStart = req.body.start;
    var sAmount = req.body.length;
    var search = req.body.search;

    if(sStart && sStart.length > 0){
        start = parseInt(sStart,10);
        if(start < 0){
            start = 0;
        }
    }
    if(sAmount && sAmount.length > 0){
        amount = parseInt(sAmount,10);
    }
    var condition = [];
    condition['search'] = search['value'];
    database.getChargingList(start,amount,condition,function(err, list){
        res.json({
            'recordsTotal': list['total'],
            'recordsFiltered': list['sub'],
            'data': list['members'],
            'sql': list['sql']
        });
    });
    
}
exports.getExchangeList = function(req, res, next){
    var start = 0;
    var amount = 5;
    var sStart = req.body.start;
    var sAmount = req.body.length;
    var search = req.body.search;

    if(sStart && sStart.length > 0){
        start = parseInt(sStart,10);
        if(start < 0){
            start = 0;
        }
    }
    if(sAmount && sAmount.length > 0){
        amount = parseInt(sAmount,10);
    }
    var condition = [];
    condition['search'] = search['value'];
    database.getExchangeList(start,amount,condition,function(err, list){
        res.json({
            'recordsTotal': list['total'],
            'recordsFiltered': list['sub'],
            'data': list['members'],
            'sql': list['sql']
        });
    });
    
}

exports.getBlackList = function(req, res, next){
    var start = 0;
    var amount = 5;
    var sStart = req.body.start;
    var sAmount = req.body.length;
    var search = req.body.search;

    if(sStart && sStart.length > 0){
        start = parseInt(sStart,10);
        if(start < 0){
            start = 0;
        }
    }
    if(sAmount && sAmount.length > 0){
        amount = parseInt(sAmount,10);
    }
    var condition = [];
    condition['search'] = search['value'];
    database.getBlackList(start,amount,condition,function(err, list){
        res.json({
            'recordsTotal': list['total'],
            'recordsFiltered': list['sub'],
            'data': list['members'],
            'sql': list['sql']
        });
    });
    
}
exports.addBlackList = function(req,res,next){
    var ipaddress = req.body.ipaddress;
    database.addBlackList(ipaddress,function(err, list){
        res.json({
            'result' : 'success'
        });
    });
    
}
exports.deleteBlackList = function(req,res,next){
    var id = req.body.id;
    database.removeBlackList(id,function(err, list){
        res.json({
            'result' : 'success'
        });
    });
}

exports.saveBankCodes = function (req, res, next) {
    assert(req.user);

    database.createBankCode(req.body.bank_name, req.body.account_number, req.body.account_name, function(err) {
        console.log(err);
        return res.redirect('/admin/bank-codes');
    })
}

exports.bankCodeConfirm = function (req, res, next) {
    var bankCodeId = req.params.id;

    database.confirmBankCode(bankCodeId, function(err) {
        res.redirect('/admin/bank-codes');
    })
}

exports.bankCodeCancel = function (req, res, next) {
    var bankCodeId = req.params.id;

    database.cancelBankCode(bankCodeId, function(err) {
        res.redirect('/admin/bank-codes');
    })
}

exports.statistics = function (req, res, next) {
    var user = req.user;

    var d = new Date(),
        search_month = '' + (d.getMonth() + 1),
        search_year = d.getFullYear();

    var search_year_criteria_start = parseFloat(d.getFullYear()) - 20;
    var search_year_criteria_end = parseFloat(d.getFullYear()) ;

    if (search_month.length < 2) search_month = '0' + search_month;

    if(req.param('query_year')) {
        search_year = req.param('query_year');
        search_month = req.param('query_month');

        if (search_month.length < 2) search_month = '0' + search_month;
    }

    database.getStatistics(search_year, search_month, function(err, statistics) {
        //getting all charings and exchange for waiting
        database.getChargingWaiting(function(err, charinglist){
            var all = [];
            all.push(charinglist);
            database.getExchangeWaiting(function(err, exchangelist){
                all.push(exchangelist);
                //get latest user
                database.getLastUser(function(err, usr){
                    var lastUser = usr;
                    res.render('admin/statistics', { statistics: statistics, search_year: search_year, search_month: search_month, user:user ,lastUser: lastUser,sidebar:'statistics',requests:all, search_year_criteria_start:search_year_criteria_start, search_year_criteria_end:search_year_criteria_end});
                });

            });
        });

    })
}
/*
* Member management page
* */

