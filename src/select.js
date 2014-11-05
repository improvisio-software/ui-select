(function () {
  "use strict";

  var KEY = {
    TAB: 9,
    ENTER: 13,
    ESC: 27,
    SPACE: 32,
    LEFT: 37,
    UP: 38,
    RIGHT: 39,
    DOWN: 40,
    SHIFT: 16,
    CTRL: 17,
    ALT: 18,
    PAGE_UP: 33,
    PAGE_DOWN: 34,
    HOME: 36,
    END: 35,
    BACKSPACE: 8,
    DELETE: 46,
    COMMAND: 91,
    isControl: function (e) {
        var k = e.which;
        switch (k) {
        case KEY.COMMAND:
        case KEY.SHIFT:
        case KEY.CTRL:
        case KEY.ALT:
            return true;
        }

        if (e.metaKey) return true;

        return false;
    },
    isFunctionKey: function (k) {
        k = k.which ? k.which : k;
        return k >= 112 && k <= 123;
    },
    isVerticalMovement: function (k){
      return ~[KEY.UP, KEY.DOWN].indexOf(k);
    },
    isHorizontalMovement: function (k){
      return ~[KEY.LEFT,KEY.RIGHT,KEY.BACKSPACE,KEY.DELETE].indexOf(k);
    }
  };

  /**
   * Add querySelectorAll() to jqLite.
   *
   * jqLite find() is limited to lookups by tag name.
   * TODO This will change with future versions of AngularJS, to be removed when this happens
   *
   * See jqLite.find - why not use querySelectorAll? https://github.com/angular/angular.js/issues/3586
   * See feat(jqLite): use querySelectorAll instead of getElementsByTagName in jqLite.find https://github.com/angular/angular.js/pull/3598
   */
  if (angular.element.prototype.querySelectorAll === undefined) {
    angular.element.prototype.querySelectorAll = function(selector) {
      return angular.element(this[0].querySelectorAll(selector));
    };
  }

  angular.module('ui.select', [])

  .constant('uiSelectConfig', {
    theme: 'bootstrap',
    searchEnabled: true,
    placeholder: '', // Empty by default, like HTML tag <select>
    refreshDelay: 1000 // In milliseconds
  })

  // See Rename minErr and make it accessible from outside https://github.com/angular/angular.js/issues/6913
  .service('uiSelectMinErr', function() {
    var minErr = angular.$$minErr('ui.select');
    return function() {
      var error = minErr.apply(this, arguments);
      var message = error.message.replace(new RegExp('\nhttp://errors.angularjs.org/.*'), '');
      return new Error(message);
    };
  })

  /**
   * Parses "repeat" attribute.
   *
   * Taken from AngularJS ngRepeat source code
   * See https://github.com/angular/angular.js/blob/v1.2.15/src/ng/directive/ngRepeat.js#L211
   *
   * Original discussion about parsing "repeat" attribute instead of fully relying on ng-repeat:
   * https://github.com/angular-ui/ui-select/commit/5dd63ad#commitcomment-5504697
   */
  .service('RepeatParser', ['uiSelectMinErr','$parse', function(uiSelectMinErr, $parse) {
    var self = this;

    /**
     * Example:
     * expression = "address in addresses | filter: {street: $select.search} track by $index"
     * itemName = "address",
     * source = "addresses | filter: {street: $select.search}",
     * trackByExp = "$index",
     */
    self.parse = function(expression) {

      var match = expression.match(/^\s*(?:([\s\S]+?)\s+as\s+)?([\S]+?)\s+in\s+([\s\S]+?)(?:\s+track\s+by\s+([\s\S]+?))?\s*$/);

      if (!match) {
        throw uiSelectMinErr('iexp', "Expected expression in form of '_item_ in _collection_[ track by _id_]' but got '{0}'.",
                expression);
      }

      return {
        itemName: match[2], // (lhs) Left-hand side,
        source: $parse(match[3]),
        trackByExp: match[4],
        modelMapper: $parse(match[1] || match[2])
      };

    };

    self.getGroupNgRepeatExpression = function() {
      return '$group in $select.groups';
    };

    self.getNgRepeatExpression = function(itemName, source, trackByExp, grouped) {
      var expression = itemName + ' in ' + (grouped ? '$group.items' : source);
      if (trackByExp) {
        expression += ' track by ' + trackByExp;
      }
      return expression;
    };
  }])

  /**
   * Contains ui-select "intelligence".
   *
   * The goal is to limit dependency on the DOM whenever possible and
   * put as much logic in the controller (instead of the link functions) as possible so it can be easily tested.
   */
  .controller('uiSelectCtrl',
    ['$scope', '$element', '$timeout', 'RepeatParser', 'uiSelectMinErr',
    function($scope, $element, $timeout, RepeatParser, uiSelectMinErr) {

    var ctrl = this;

    var EMPTY_SEARCH = '';

    ctrl.placeholder = undefined;
    ctrl.search = EMPTY_SEARCH;
    ctrl.activeIndex = 0;
    ctrl.activeMatchIndex = -1;
    ctrl.items = [];
    ctrl.selected = undefined;
    ctrl.open = false;
    ctrl.focus = false;
    ctrl.focusser = undefined; //Reference to input element used to handle focus events
    ctrl.disabled = undefined; // Initialized inside uiSelect directive link function
    ctrl.searchEnabled = undefined; // Initialized inside uiSelect directive link function
    ctrl.resetSearchInput = undefined; // Initialized inside uiSelect directive link function
    ctrl.refreshDelay = undefined; // Initialized inside uiSelectChoices directive link function
    ctrl.multiple = false; // Initialized inside uiSelect directive link function
    ctrl.disableChoiceExpression = undefined; // Initialized inside uiSelect directive link function

    ctrl.isEmpty = function() {
      return angular.isUndefined(ctrl.selected) || ctrl.selected === null || ctrl.selected === '';
    };

    var _searchInput = $element.querySelectorAll('input.ui-select-search');
    if (_searchInput.length !== 1) {
      throw uiSelectMinErr('searchInput', "Expected 1 input.ui-select-search but got '{0}'.", _searchInput.length);
    }

    // Most of the time the user does not want to empty the search input when in typeahead mode
    function _resetSearchInput() {
      if (ctrl.resetSearchInput) {
        ctrl.search = EMPTY_SEARCH;
        //reset activeIndex
        if (ctrl.selected && ctrl.items.length && !ctrl.multiple) {
          ctrl.activeIndex = ctrl.items.indexOf(ctrl.selected);
        }
      }
    }

    function isMobile() {
      var a = window.navigator.userAgent||window.navigator.vendor||window.opera;
      return /(android|bb\d+|meego).+mobile|avantgo|bada\/|blackberry|blazer|compal|elaine|fennec|hiptop|iemobile|ip(hone|od)|iris|kindle|lge |maemo|midp|mmp|mobile.+firefox|netfront|opera m(ob|in)i|palm( os)?|phone|p(ixi|re)\/|plucker|pocket|psp|series(4|6)0|symbian|treo|up\.(browser|link)|vodafone|wap|windows (ce|phone)|xda|xiino/i.test(a)||/1207|6310|6590|3gso|4thp|50[1-6]i|770s|802s|a wa|abac|ac(er|oo|s\-)|ai(ko|rn)|al(av|ca|co)|amoi|an(ex|ny|yw)|aptu|ar(ch|go)|as(te|us)|attw|au(di|\-m|r |s )|avan|be(ck|ll|nq)|bi(lb|rd)|bl(ac|az)|br(e|v)w|bumb|bw\-(n|u)|c55\/|capi|ccwa|cdm\-|cell|chtm|cldc|cmd\-|co(mp|nd)|craw|da(it|ll|ng)|dbte|dc\-s|devi|dica|dmob|do(c|p)o|ds(12|\-d)|el(49|ai)|em(l2|ul)|er(ic|k0)|esl8|ez([4-7]0|os|wa|ze)|fetc|fly(\-|_)|g1 u|g560|gene|gf\-5|g\-mo|go(\.w|od)|gr(ad|un)|haie|hcit|hd\-(m|p|t)|hei\-|hi(pt|ta)|hp( i|ip)|hs\-c|ht(c(\-| |_|a|g|p|s|t)|tp)|hu(aw|tc)|i\-(20|go|ma)|i230|iac( |\-|\/)|ibro|idea|ig01|ikom|im1k|inno|ipaq|iris|ja(t|v)a|jbro|jemu|jigs|kddi|keji|kgt( |\/)|klon|kpt |kwc\-|kyo(c|k)|le(no|xi)|lg( g|\/(k|l|u)|50|54|\-[a-w])|libw|lynx|m1\-w|m3ga|m50\/|ma(te|ui|xo)|mc(01|21|ca)|m\-cr|me(rc|ri)|mi(o8|oa|ts)|mmef|mo(01|02|bi|de|do|t(\-| |o|v)|zz)|mt(50|p1|v )|mwbp|mywa|n10[0-2]|n20[2-3]|n30(0|2)|n50(0|2|5)|n7(0(0|1)|10)|ne((c|m)\-|on|tf|wf|wg|wt)|nok(6|i)|nzph|o2im|op(ti|wv)|oran|owg1|p800|pan(a|d|t)|pdxg|pg(13|\-([1-8]|c))|phil|pire|pl(ay|uc)|pn\-2|po(ck|rt|se)|prox|psio|pt\-g|qa\-a|qc(07|12|21|32|60|\-[2-7]|i\-)|qtek|r380|r600|raks|rim9|ro(ve|zo)|s55\/|sa(ge|ma|mm|ms|ny|va)|sc(01|h\-|oo|p\-)|sdk\/|se(c(\-|0|1)|47|mc|nd|ri)|sgh\-|shar|sie(\-|m)|sk\-0|sl(45|id)|sm(al|ar|b3|it|t5)|so(ft|ny)|sp(01|h\-|v\-|v )|sy(01|mb)|t2(18|50)|t6(00|10|18)|ta(gt|lk)|tcl\-|tdg\-|tel(i|m)|tim\-|t\-mo|to(pl|sh)|ts(70|m\-|m3|m5)|tx\-9|up(\.b|g1|si)|utst|v400|v750|veri|vi(rg|te)|vk(40|5[0-3]|\-v)|vm40|voda|vulc|vx(52|53|60|61|70|80|81|83|85|98)|w3c(\-| )|webc|whit|wi(g |nc|nw)|wmlb|wonu|x700|yas\-|your|zeto|zte\-/i.test(a.substr(0,4));
    }

    // When the user clicks on ui-select, displays the dropdown list
    ctrl.activate = function(initSearchValue, avoidReset) {
      if (!ctrl.disabled  && !ctrl.open) {
        if(!avoidReset) _resetSearchInput();
        ctrl.focusser.prop('disabled', true); //Will reactivate it on .close()
        ctrl.open = true;
        ctrl.activeMatchIndex = -1;

        ctrl.activeIndex = ctrl.activeIndex >= ctrl.items.length ? 0 : ctrl.activeIndex;

        // Give it time to appear before focus
        $timeout(function() {
          ctrl.search = initSearchValue || ctrl.search;
          if (!isMobile()) {
            _searchInput[0].focus();
          }
        });
      }
    };

    ctrl.findGroupByName = function(name) {
      return ctrl.groups && ctrl.groups.filter(function(group) {
        return group.name === name;
      })[0];
    };

    ctrl.parseRepeatAttr = function(repeatAttr, groupByExp) {
      function updateGroups(items) {
        ctrl.groups = [];
        angular.forEach(items, function(item) {
          var groupFn = $scope.$eval(groupByExp);
          var groupName = angular.isFunction(groupFn) ? groupFn(item) : item[groupFn];
          var group = ctrl.findGroupByName(groupName);
          if(group) {
            group.items.push(item);
          }
          else {
            ctrl.groups.push({name: groupName, items: [item]});
          }
        });
        ctrl.items = [];
        ctrl.groups.forEach(function(group) {
          ctrl.items = ctrl.items.concat(group.items);
        });
      }

      function setPlainItems(items) {
        ctrl.items = items;
      }

      var setItemsFn = groupByExp ? updateGroups : setPlainItems;

      ctrl.parserResult = RepeatParser.parse(repeatAttr);

      ctrl.isGrouped = !!groupByExp;
      ctrl.itemProperty = ctrl.parserResult.itemName;

      // See https://github.com/angular/angular.js/blob/v1.2.15/src/ng/directive/ngRepeat.js#L259
      $scope.$watchCollection(ctrl.parserResult.source, function(items) {

        if (items === undefined || items === null) {
          // If the user specifies undefined or null => reset the collection
          // Special case: items can be undefined if the user did not initialized the collection on the scope
          // i.e $scope.addresses = [] is missing
          ctrl.items = [];
        } else {
          if (!angular.isArray(items)) {
            throw uiSelectMinErr('items', "Expected an array but got '{0}'.", items);
          } else {
            if (ctrl.multiple){
              //Remove already selected items (ex: while searching)
              var filteredItems = items.filter(function(i) {return ctrl.selected.indexOf(i) < 0;});
              setItemsFn(filteredItems);
            }else{
              setItemsFn(items);
            }
            ctrl.ngModel.$modelValue = null; //Force scope model value and ngModel value to be out of sync to re-run formatters

          }
        }

      });

      if (ctrl.multiple){
        //Remove already selected items
        $scope.$watchCollection('$select.selected', function(selectedItems){
          var data = ctrl.parserResult.source($scope);
          if (!selectedItems.length) {
            setItemsFn(data);
          }else{
            var filteredItems = data.filter(function(i) {return selectedItems.indexOf(i) < 0;});
            setItemsFn(filteredItems);
          }
          ctrl.sizeSearchInput();
        });
      }

    };

    var _refreshDelayPromise;

    /**
     * Typeahead mode: lets the user refresh the collection using his own function.
     *
     * See Expose $select.search for external / remote filtering https://github.com/angular-ui/ui-select/pull/31
     */
    ctrl.refresh = function(refreshAttr) {
      if (refreshAttr !== undefined) {

        // Debounce
        // See https://github.com/angular-ui/bootstrap/blob/0.10.0/src/typeahead/typeahead.js#L155
        // FYI AngularStrap typeahead does not have debouncing: https://github.com/mgcrea/angular-strap/blob/v2.0.0-rc.4/src/typeahead/typeahead.js#L177
        if (_refreshDelayPromise) {
          $timeout.cancel(_refreshDelayPromise);
        }
        _refreshDelayPromise = $timeout(function() {
          $scope.$eval(refreshAttr);
        }, ctrl.refreshDelay);
      }
    };

    ctrl.setActiveItem = function(item) {
      ctrl.activeIndex = ctrl.items.indexOf(item);
    };

    ctrl.isActive = function(itemScope) {
      return ctrl.open && ctrl.items.indexOf(itemScope[ctrl.itemProperty]) === ctrl.activeIndex;
    };

    ctrl.isDisabled = function(itemScope) {

      if (!ctrl.open) return;

      var itemIndex = ctrl.items.indexOf(itemScope[ctrl.itemProperty]);
      var isDisabled = false;
      var item;

      if (itemIndex >= 0 && !angular.isUndefined(ctrl.disableChoiceExpression)) {
        item = ctrl.items[itemIndex];
        isDisabled = !!(itemScope.$eval(ctrl.disableChoiceExpression)); // force the boolean value
        item._uiSelectChoiceDisabled = isDisabled; // store this for later reference
      }

      return isDisabled;
    };

    // When the user clicks on an item inside the dropdown
    ctrl.select = function(item, skipFocusser) {

      if (item === undefined || !item._uiSelectChoiceDisabled) {
        var locals = {};
        locals[ctrl.parserResult.itemName] = item;

        ctrl.onSelectCallback($scope, {
            $item: item,
            $model: ctrl.parserResult.modelMapper($scope, locals)
        });

        if(ctrl.multiple){
          ctrl.selected.push(item);
          ctrl.sizeSearchInput();
        } else {
          ctrl.selected = item;
        }
        ctrl.close(skipFocusser);
      }
    };

    // Closes the dropdown
    ctrl.close = function(skipFocusser) {
      if (!ctrl.open) return;
      _resetSearchInput();
      ctrl.open = false;
      if (!ctrl.multiple){
        $timeout(function(){
          ctrl.focusser.prop('disabled', false);
          if (!skipFocusser) ctrl.focusser[0].focus();
        },0,false);
      }
    };

    // Toggle dropdown
    ctrl.toggle = function(e) {
      if (ctrl.open) ctrl.close(); else ctrl.activate();
      e.preventDefault();
      e.stopPropagation();
    };

    // Remove item from multiple select
    ctrl.removeChoice = function(index){
      var removedChoice = ctrl.selected[index];
      var locals = {};
      locals[ctrl.parserResult.itemName] = removedChoice;

      ctrl.selected.splice(index, 1);
      ctrl.activeMatchIndex = -1;
      ctrl.sizeSearchInput();

      ctrl.onRemoveCallback($scope, {
        $item: removedChoice,
        $model: ctrl.parserResult.modelMapper($scope, locals)
      });
    };

    ctrl.getPlaceholder = function(){
      //Refactor single?
      if(ctrl.multiple && ctrl.selected.length) return;
      return ctrl.placeholder;
    };

    var containerSizeWatch;
    ctrl.sizeSearchInput = function(){
      var input = _searchInput[0],
          container = _searchInput.parent().parent()[0];
      _searchInput.css('width','10px');
      var calculate = function(){
        var newWidth = container.clientWidth - input.offsetLeft - 10;
        if(newWidth < 50) newWidth = container.clientWidth;
        _searchInput.css('width',newWidth+'px');
      };
      $timeout(function(){ //Give tags time to render correctly
        if (container.clientWidth === 0 && !containerSizeWatch){
          containerSizeWatch = $scope.$watch(function(){ return container.clientWidth;}, function(newValue){
            if (newValue !== 0){
              calculate();
              containerSizeWatch();
              containerSizeWatch = null;
            }
          });
        }else if (!containerSizeWatch) {
          calculate();
        }
      }, 0, false);
    };

    function _handleDropDownSelection(key) {
      var processed = true;
      switch (key) {
        case KEY.DOWN:
          if (!ctrl.open && ctrl.multiple) ctrl.activate(false, true); //In case its the search input in 'multiple' mode
          else if (ctrl.activeIndex < ctrl.items.length - 1) { ctrl.activeIndex++; }
          break;
        case KEY.UP:
          if (!ctrl.open && ctrl.multiple) ctrl.activate(false, true); //In case its the search input in 'multiple' mode
          else if (ctrl.activeIndex > 0) { ctrl.activeIndex--; }
          break;
        case KEY.TAB:
          if (!ctrl.multiple || ctrl.open) ctrl.select(ctrl.items[ctrl.activeIndex], true);
          break;
        case KEY.ENTER:
          if(ctrl.open){
            ctrl.select(ctrl.items[ctrl.activeIndex]);
          } else {
            ctrl.activate(false, true); //In case its the search input in 'multiple' mode
          }
          break;
        case KEY.ESC:
          ctrl.close();
          break;
        default:
          processed = false;
      }
      return processed;
    }

    // Handles selected options in "multiple" mode
    function _handleMatchSelection(key){
      var caretPosition = _getCaretPosition(_searchInput[0]),
          length = ctrl.selected.length,
          // none  = -1,
          first = 0,
          last  = length-1,
          curr  = ctrl.activeMatchIndex,
          next  = ctrl.activeMatchIndex+1,
          prev  = ctrl.activeMatchIndex-1,
          newIndex = curr;

      if(caretPosition > 0 || (ctrl.search.length && key == KEY.RIGHT)) return false;

      ctrl.close();

      function getNewActiveMatchIndex(){
        switch(key){
          case KEY.LEFT:
            // Select previous/first item
            if(~ctrl.activeMatchIndex) return prev;
            // Select last item
            else return last;
            break;
          case KEY.RIGHT:
            // Open drop-down
            if(!~ctrl.activeMatchIndex || curr === last){
              ctrl.activate();
              return false;
            }
            // Select next/last item
            else return next;
            break;
          case KEY.BACKSPACE:
            // Remove selected item and select previous/first
            if(~ctrl.activeMatchIndex){
              ctrl.removeChoice(curr);
              return prev;
            }
            // Select last item
            else return last;
            break;
          case KEY.DELETE:
            // Remove selected item and select next item
            if(~ctrl.activeMatchIndex){
              ctrl.removeChoice(ctrl.activeMatchIndex);
              return curr;
            }
            else return false;
        }
      }

      newIndex = getNewActiveMatchIndex();

      if(!ctrl.selected.length || newIndex === false) ctrl.activeMatchIndex = -1;
      else ctrl.activeMatchIndex = Math.min(last,Math.max(first,newIndex));

      return true;
    }

    // Bind to keyboard shortcuts
    _searchInput.on('keydown', function(e) {

      var key = e.which;

      // if(~[KEY.ESC,KEY.TAB].indexOf(key)){
      //   //TODO: SEGURO?
      //   ctrl.close();
      // }

      $scope.$apply(function() {
        var processed = false;

        if(ctrl.multiple && KEY.isHorizontalMovement(key)){
          processed = _handleMatchSelection(key);
        }

        if (!processed && ctrl.items.length > 0) {
          processed = _handleDropDownSelection(key);
        }

        if (processed  && key != KEY.TAB) {
          //TODO Check si el tab selecciona aun correctamente
          //Crear test
          e.preventDefault();
          e.stopPropagation();
        }
      });

      if(KEY.isVerticalMovement(key) && ctrl.items.length > 0){
        _ensureHighlightVisible();
      }

    });

    _searchInput.on('blur', function() {
      $timeout(function() {
        ctrl.activeMatchIndex = -1;
      });
    });

    function _getCaretPosition(el) {
      if(angular.isNumber(el.selectionStart)) return el.selectionStart;
      // selectionStart is not supported in IE8 and we don't want hacky workarounds so we compromise
      else return el.value.length;
    }

    // See https://github.com/ivaynberg/select2/blob/3.4.6/select2.js#L1431
    function _ensureHighlightVisible() {
      var container = $element.querySelectorAll('.ui-select-choices-content');
      var choices = container.querySelectorAll('.ui-select-choices-row');
      if (choices.length < 1) {
        throw uiSelectMinErr('choices', "Expected multiple .ui-select-choices-row but got '{0}'.", choices.length);
      }

      var highlighted = choices[ctrl.activeIndex];
      var posY = highlighted.offsetTop + highlighted.clientHeight - container[0].scrollTop;
      var height = container[0].offsetHeight;

      if (posY > height) {
        container[0].scrollTop += posY - height;
      } else if (posY < highlighted.clientHeight) {
        if (ctrl.isGrouped && ctrl.activeIndex === 0)
          container[0].scrollTop = 0; //To make group header visible when going all the way up
        else
          container[0].scrollTop -= highlighted.clientHeight - posY;
      }
    }

    $scope.$on('$destroy', function() {
      _searchInput.off('keydown blur');
    });
  }])

  .directive('uiSelect',
    ['$document', 'uiSelectConfig', 'uiSelectMinErr', '$compile', '$parse',
    function($document, uiSelectConfig, uiSelectMinErr, $compile, $parse) {

    return {
      restrict: 'EA',
      templateUrl: function(tElement, tAttrs) {
        var theme = tAttrs.theme || uiSelectConfig.theme;
        return theme + (angular.isDefined(tAttrs.multiple) ? '/select-multiple.tpl.html' : '/select.tpl.html');
      },
      replace: true,
      transclude: true,
      require: ['uiSelect', 'ngModel'],
      scope: true,

      controller: 'uiSelectCtrl',
      controllerAs: '$select',

      link: function(scope, element, attrs, ctrls, transcludeFn) {
        var $select = ctrls[0];
        var ngModel = ctrls[1];

        var searchInput = element.querySelectorAll('input.ui-select-search');

        $select.multiple = (angular.isDefined(attrs.multiple)) ? (attrs.multiple === '') ? true : (attrs.multiple.toLowerCase() === 'true') : false;

        $select.onSelectCallback = $parse(attrs.onSelect);
        $select.onRemoveCallback = $parse(attrs.onRemove);

        //From view --> model
        ngModel.$parsers.unshift(function (inputValue) {
          var locals = {},
              result;
          if ($select.multiple){
            var resultMultiple = [];
            for (var j = $select.selected.length - 1; j >= 0; j--) {
              locals = {};
              locals[$select.parserResult.itemName] = $select.selected[j];
              result = $select.parserResult.modelMapper(scope, locals);
              resultMultiple.unshift(result);
            }
            return resultMultiple;
          }else{
            locals = {};
            locals[$select.parserResult.itemName] = inputValue;
            result = $select.parserResult.modelMapper(scope, locals);
            return result;
          }
        });

        //From model --> view
        ngModel.$formatters.unshift(function (inputValue) {
          var data = $select.parserResult.source (scope, { $select : {search:''}}), //Overwrite $search
              locals = {},
              result;
          if (data){
            if ($select.multiple){
              var resultMultiple = [];
              var checkFnMultiple = function(list, value){
                if (!list || !list.length) return;
                for (var p = list.length - 1; p >= 0; p--) {
                  locals[$select.parserResult.itemName] = list[p];
                  result = $select.parserResult.modelMapper(scope, locals);
                  if (result == value){
                    resultMultiple.unshift(list[p]);
                    return true;
                  }
                }
                return false;
              };
              if (!inputValue) return resultMultiple; //If ngModel was undefined
              for (var k = inputValue.length - 1; k >= 0; k--) {
                if (!checkFnMultiple($select.selected, inputValue[k])){
                  checkFnMultiple(data, inputValue[k]);
                }
              }
              return resultMultiple;
            }else{
              var checkFnSingle = function(d){
                locals[$select.parserResult.itemName] = d;
                result = $select.parserResult.modelMapper(scope, locals);
                return result == inputValue;
              };
              //If possible pass same object stored in $select.selected
              if ($select.selected && checkFnSingle($select.selected)) {
                return $select.selected;
              }
              for (var i = data.length - 1; i >= 0; i--) {
                if (checkFnSingle(data[i])) return data[i];
              }
            }
          }
          return inputValue;
        });

        //Set reference to ngModel from uiSelectCtrl
        $select.ngModel = ngModel;

        //Idea from: https://github.com/ivaynberg/select2/blob/79b5bf6db918d7560bdd959109b7bcfb47edaf43/select2.js#L1954
        var focusser = angular.element("<input ng-disabled='$select.disabled' class='ui-select-focusser ui-select-offscreen' type='text' aria-haspopup='true' role='button' />");

        if(attrs.tabindex){
          //tabindex might be an expression, wait until it contains the actual value before we set the focusser tabindex
          attrs.$observe('tabindex', function(value) {
            //If we are using multiple, add tabindex to the search input
            if($select.multiple){
              searchInput.attr("tabindex", value);
            } else {
              focusser.attr("tabindex", value);
            }
            //Remove the tabindex on the parent so that it is not focusable
            element.removeAttr("tabindex");
          });
        }

        $compile(focusser)(scope);
        $select.focusser = focusser;

        if (!$select.multiple){

          element.append(focusser);
          focusser.bind("focus", function(){
            scope.$evalAsync(function(){
              $select.focus = true;
            });
          });
          focusser.bind("blur", function(){
            scope.$evalAsync(function(){
              $select.focus = false;
            });
          });
          focusser.bind("keydown", function(e){

            if (e.which === KEY.BACKSPACE) {
              e.preventDefault();
              e.stopPropagation();
              $select.select(undefined);
              scope.$apply();
              return;
            }

            if (e.which === KEY.TAB || KEY.isControl(e) || KEY.isFunctionKey(e) || e.which === KEY.ESC) {
              return;
            }

            if (e.which == KEY.DOWN  || e.which == KEY.UP || e.which == KEY.ENTER || e.which == KEY.SPACE){
              e.preventDefault();
              e.stopPropagation();
              $select.activate();
            }

            scope.$digest();
          });

          focusser.bind("keyup input", function(e){

            if (e.which === KEY.TAB || KEY.isControl(e) || KEY.isFunctionKey(e) || e.which === KEY.ESC || e.which == KEY.ENTER || e.which === KEY.BACKSPACE) {
              return;
            }

            $select.activate(focusser.val()); //User pressed some regular key, so we pass it to the search input
            focusser.val('');
            scope.$digest();

          });

        }


        scope.$watch('searchEnabled', function() {
            var searchEnabled = scope.$eval(attrs.searchEnabled);
            $select.searchEnabled = searchEnabled !== undefined ? searchEnabled : uiSelectConfig.searchEnabled;
        });

        attrs.$observe('disabled', function() {
          // No need to use $eval() (thanks to ng-disabled) since we already get a boolean instead of a string
          $select.disabled = attrs.disabled !== undefined ? attrs.disabled : false;
        });

        attrs.$observe('resetSearchInput', function() {
          // $eval() is needed otherwise we get a string instead of a boolean
          var resetSearchInput = scope.$eval(attrs.resetSearchInput);
          $select.resetSearchInput = resetSearchInput !== undefined ? resetSearchInput : true;
        });

        if ($select.multiple){
          scope.$watchCollection(function(){ return ngModel.$modelValue; }, function(newValue, oldValue) {
            if (oldValue != newValue)
              ngModel.$modelValue = null; //Force scope model value and ngModel value to be out of sync to re-run formatters
          });
          scope.$watchCollection('$select.selected', function() {
            ngModel.$setViewValue(Date.now()); //Set timestamp as a unique string to force changes
          });
          focusser.prop('disabled', true); //Focusser isn't needed if multiple
        }else{
          scope.$watch('$select.selected', function(newValue) {
            if (ngModel.$viewValue !== newValue) {
              ngModel.$setViewValue(newValue);
            }
          });
        }

        ngModel.$render = function() {
          if($select.multiple){
            // Make sure that model value is array
            if(!angular.isArray(ngModel.$viewValue)){
              // Have tolerance for null or undefined values
              if(angular.isUndefined(ngModel.$viewValue) || ngModel.$viewValue === null){
                $select.selected = [];
              } else {
                throw uiSelectMinErr('multiarr', "Expected model value to be array but got '{0}'", ngModel.$viewValue);
              }
            }
          }
          $select.selected = ngModel.$viewValue;
        };

        function onDocumentClick(e) {
          var contains = false;

          if (window.jQuery) {
            // Firefox 3.6 does not support element.contains()
            // See Node.contains https://developer.mozilla.org/en-US/docs/Web/API/Node.contains
            contains = window.jQuery.contains(element[0], e.target);
          } else {
            contains = element[0].contains(e.target);
          }

          if (!contains) {
            $select.close();
            scope.$digest();
          }
        }

        // See Click everywhere but here event http://stackoverflow.com/questions/12931369
        $document.on('click', onDocumentClick);

        scope.$on('$destroy', function() {
          $document.off('click', onDocumentClick);
        });

        // Move transcluded elements to their correct position in main template
        transcludeFn(scope, function(clone) {
          // See Transclude in AngularJS http://blog.omkarpatil.com/2012/11/transclude-in-angularjs.html

          // One day jqLite will be replaced by jQuery and we will be able to write:
          // var transcludedElement = clone.filter('.my-class')
          // instead of creating a hackish DOM element:
          var transcluded = angular.element('<div>').append(clone);

          var transcludedMatch = transcluded.querySelectorAll('.ui-select-match');
          transcludedMatch.removeAttr('ui-select-match'); //To avoid loop in case directive as attr
          if (transcludedMatch.length !== 1) {
            throw uiSelectMinErr('transcluded', "Expected 1 .ui-select-match but got '{0}'.", transcludedMatch.length);
          }
          element.querySelectorAll('.ui-select-match').replaceWith(transcludedMatch);

          var transcludedChoices = transcluded.querySelectorAll('.ui-select-choices');
          transcludedChoices.removeAttr('ui-select-choices'); //To avoid loop in case directive as attr
          if (transcludedChoices.length !== 1) {
            throw uiSelectMinErr('transcluded', "Expected 1 .ui-select-choices but got '{0}'.", transcludedChoices.length);
          }
          element.querySelectorAll('.ui-select-choices').replaceWith(transcludedChoices);
        });
      }
    };
  }])

  .directive('uiSelectChoices',
    ['uiSelectConfig', 'RepeatParser', 'uiSelectMinErr', '$compile',
    function(uiSelectConfig, RepeatParser, uiSelectMinErr, $compile) {

    return {
      restrict: 'EA',
      require: '^uiSelect',
      replace: true,
      transclude: true,
      templateUrl: function(tElement) {
        // Gets theme attribute from parent (ui-select)
        var theme = tElement.parent().attr('theme') || uiSelectConfig.theme;
        return theme + '/choices.tpl.html';
      },

      compile: function(tElement, tAttrs) {

        if (!tAttrs.repeat) throw uiSelectMinErr('repeat', "Expected 'repeat' expression.");

        return function link(scope, element, attrs, $select, transcludeFn) {

          // var repeat = RepeatParser.parse(attrs.repeat);
          var groupByExp = attrs.groupBy;

          $select.parseRepeatAttr(attrs.repeat, groupByExp); //Result ready at $select.parserResult

          $select.disableChoiceExpression = attrs.uiDisableChoice;

          if(groupByExp) {
            var groups = element.querySelectorAll('.ui-select-choices-group');
            if (groups.length !== 1) throw uiSelectMinErr('rows', "Expected 1 .ui-select-choices-group but got '{0}'.", groups.length);
            groups.attr('ng-repeat', RepeatParser.getGroupNgRepeatExpression());
          }

          var choices = element.querySelectorAll('.ui-select-choices-row');
          if (choices.length !== 1) {
            throw uiSelectMinErr('rows', "Expected 1 .ui-select-choices-row but got '{0}'.", choices.length);
          }

          choices.attr('ng-repeat', RepeatParser.getNgRepeatExpression($select.parserResult.itemName, '$select.items', $select.parserResult.trackByExp, groupByExp))
              .attr('ng-if', '$select.open') //Prevent unnecessary watches when dropdown is closed
              .attr('ng-mouseenter', '$select.setActiveItem('+$select.parserResult.itemName +')')
              .attr('ng-click', '$select.select(' + $select.parserResult.itemName + ')');

          var rowsInner = element.querySelectorAll('.ui-select-choices-row-inner');
          if (rowsInner.length !== 1) throw uiSelectMinErr('rows', "Expected 1 .ui-select-choices-row-inner but got '{0}'.", rowsInner.length);
          rowsInner.attr('uis-transclude-append', ''); //Adding uisTranscludeAppend directive to row element after choices element has ngRepeat

          $compile(element, transcludeFn)(scope); //Passing current transcludeFn to be able to append elements correctly from uisTranscludeAppend

          scope.$watch('$select.search', function(newValue) {
            if(newValue && !$select.open && $select.multiple) $select.activate(false, true);
            $select.activeIndex = 0;
            $select.refresh(attrs.refresh);
          });

          attrs.$observe('refreshDelay', function() {
            // $eval() is needed otherwise we get a string instead of a number
            var refreshDelay = scope.$eval(attrs.refreshDelay);
            $select.refreshDelay = refreshDelay !== undefined ? refreshDelay : uiSelectConfig.refreshDelay;
          });
        };
      }
    };
  }])
  // Recreates old behavior of ng-transclude. Used internally.
  .directive('uisTranscludeAppend', function () {
    return {
      link: function (scope, element, attrs, ctrl, transclude) {
          transclude(scope, function (clone) {
            element.append(clone);
          });
        }
      };
  })
  .directive('uiSelectMatch', ['uiSelectConfig', function(uiSelectConfig) {
    return {
      restrict: 'EA',
      require: '^uiSelect',
      replace: true,
      transclude: true,
      templateUrl: function(tElement) {
        // Gets theme attribute from parent (ui-select)
        var theme = tElement.parent().attr('theme') || uiSelectConfig.theme;
        var multi = tElement.parent().attr('multiple');
        return theme + (multi ? '/match-multiple.tpl.html' : '/match.tpl.html');
      },
      link: function(scope, element, attrs, $select) {
        attrs.$observe('placeholder', function(placeholder) {
          $select.placeholder = placeholder !== undefined ? placeholder : uiSelectConfig.placeholder;
        });

        if($select.multiple){
            $select.sizeSearchInput();
        }

      }
    };
  }])

  /**
   * Highlights text that matches $select.search.
   *
   * Taken from AngularUI Bootstrap Typeahead
   * See https://github.com/angular-ui/bootstrap/blob/0.10.0/src/typeahead/typeahead.js#L340
   */
  .filter('highlight', function() {
    function escapeRegexp(queryToEscape) {
      return queryToEscape.replace(/([.?*+^$[\]\\(){}|-])/g, '\\$1');
    }

    return function(matchItem, query) {
      return query && matchItem ? matchItem.replace(new RegExp(escapeRegexp(query), 'gi'), '<span class="ui-select-highlight">$&</span>') : matchItem;
    };
  });
}());
