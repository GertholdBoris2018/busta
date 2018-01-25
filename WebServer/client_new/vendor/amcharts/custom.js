function CustomChart(startingFrom, cum, chartData) {

    chartData.reverse();
    chartData.forEach(function(entry, i) {
        var profit = (entry.cash_out ? entry.cash_out : 0) + (entry.bonus ? entry.bonus : 0) - entry.bet;
        cum += profit;
        entry.cum_profit = (cum/100);
        entry.n = startingFrom+i;
        if (profit > 0) {
          entry.force_color = 'green'
        } else if (profit < 0) {
          entry.force_color = 'red'
        } else {
          entry.force_color = 'gray'
        }
    });

    AmCharts.ready(function () {

        function frmt(x) {
            var entry = x.dataContext;
            var profit = (entry.cash_out ? entry.cash_out : 0) + (entry.bonus ? entry.bonus : 0) - entry.bet;

            var r = "<table>" +
               
                '<tr><th>배팅금액:</th><td>' + (entry.bet/100).toFixed() + ' 원</td></tr>' +
                "<tr><th>게임결과:</th><td>" + (typeof entry.game_crash !== 'undefined' ? (entry.game_crash/100).toFixed(2) + 'x' : '?') + "</td></tr>" +
                "<tr><th>내 결과:</th><td>" + (entry.cash_out ? (entry.cash_out / entry.bet).toFixed(2) + 'x' : '-') + "</td></tr>" +
                '<tr><th>보너스: </th><td>' + (entry.bonus ? (entry.bonus/100).toFixed(0) : 0) + ' 원</td></tr>' +
                "<tr><th>순익:</th><td><b>" + (profit/100).toFixed(0) + " 원</b></td></tr>" +
                '</table>';
            return r;

        }


        var chart = AmCharts.makeChart("chartdiv", {
            "theme": "none",
            "type": "serial",
            "autoMargins": false,
            "marginLeft": 20,
            "marginRight": 8,
            "marginTop": 10,
            "marginBottom": 26,
            "pathToImages": "/vendor/amcharts/images/",
            "dataProvider": chartData,
            "valueAxes": [
                {
                    "axisAlpha": 0,
                    "inside": true,
                    "title": 'Cumulative Net Profit'
                }
            ],
            "graphs": [
                {
                    "useNegativeColorIfDown": true,

                    "bullet": "round",
                    "bulletBorderAlpha": 1,
                    "bulletBorderColor": "#FFFFFF",
                    "balloonFunction": frmt,
                    "lineThickness": 2,
                    "lineColor": "green",
                    "negativeLineColor": "red",
                    "valueField": "cum_profit",
                    "colorField": "force_color"
                }
            ],
            "chartCursor": {
                cursorColor: "black"
            },
            "categoryField": "n"
        });

        chart.addListener("clickGraphItem", function (event) {
            var gameId = event.item.dataContext.game_id;
            window.location="/game/" + gameId;
        });


    });

}