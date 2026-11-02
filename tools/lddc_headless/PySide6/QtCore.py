# Minimal QtCore compatibility layer for running LDDC's non-GUI API headlessly.
class QObject:
    def __init__(self, *args, **kwargs):
        pass


class _Signal:
    def __init__(self, *types):
        self.types = types
        self._name = None

    def __set_name__(self, owner, name):
        self._name = "_signal_" + name

    def __get__(self, obj, owner=None):
        if obj is None:
            return self
        sig = obj.__dict__.get(self._name)
        if sig is None:
            sig = _BoundSignal()
            obj.__dict__[self._name] = sig
        return sig


class _BoundSignal:
    def __init__(self):
        self._slots = []

    def connect(self, slot):
        self._slots.append(slot)

    def disconnect(self, slot=None):
        if slot is None:
            self._slots.clear()
        elif slot in self._slots:
            self._slots.remove(slot)

    def emit(self, *args):
        for slot in list(self._slots):
            slot(*args)


Signal = _Signal


class QCoreApplication:
    @staticmethod
    def translate(context, text, *args):
        return text


class QLoggingCategory:
    @staticmethod
    def setFilterRules(rules):
        pass


class QMessageLogContext:
    file = None
    line = 0
    function = None
    category = None


class QtMsgType:
    QtDebugMsg = 0
    QtInfoMsg = 1
    QtWarningMsg = 2
    QtCriticalMsg = 3
    QtFatalMsg = 4


def qInstallMessageHandler(handler):
    return None
