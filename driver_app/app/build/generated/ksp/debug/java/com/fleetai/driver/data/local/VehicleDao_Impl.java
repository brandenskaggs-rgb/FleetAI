package com.fleetai.driver.data.local;

import android.database.Cursor;
import android.os.CancellationSignal;
import androidx.annotation.NonNull;
import androidx.room.CoroutinesRoom;
import androidx.room.EntityInsertionAdapter;
import androidx.room.RoomDatabase;
import androidx.room.RoomSQLiteQuery;
import androidx.room.SharedSQLiteStatement;
import androidx.room.util.CursorUtil;
import androidx.room.util.DBUtil;
import androidx.sqlite.db.SupportSQLiteStatement;
import java.lang.Class;
import java.lang.Exception;
import java.lang.Object;
import java.lang.Override;
import java.lang.String;
import java.lang.SuppressWarnings;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.Callable;
import javax.annotation.processing.Generated;
import kotlin.Unit;
import kotlin.coroutines.Continuation;

@Generated("androidx.room.RoomProcessor")
@SuppressWarnings({"unchecked", "deprecation"})
public final class VehicleDao_Impl implements VehicleDao {
  private final RoomDatabase __db;

  private final EntityInsertionAdapter<VehicleEntity> __insertionAdapterOfVehicleEntity;

  private final SharedSQLiteStatement __preparedStmtOfClearVehicles;

  public VehicleDao_Impl(@NonNull final RoomDatabase __db) {
    this.__db = __db;
    this.__insertionAdapterOfVehicleEntity = new EntityInsertionAdapter<VehicleEntity>(__db) {
      @Override
      @NonNull
      protected String createQuery() {
        return "INSERT OR REPLACE INTO `vehicles` (`id`,`tenantId`,`unitNumber`,`vin`,`make`,`model`) VALUES (?,?,?,?,?,?)";
      }

      @Override
      protected void bind(@NonNull final SupportSQLiteStatement statement,
          @NonNull final VehicleEntity entity) {
        statement.bindString(1, entity.getId());
        statement.bindString(2, entity.getTenantId());
        statement.bindString(3, entity.getUnitNumber());
        statement.bindString(4, entity.getVin());
        statement.bindString(5, entity.getMake());
        statement.bindString(6, entity.getModel());
      }
    };
    this.__preparedStmtOfClearVehicles = new SharedSQLiteStatement(__db) {
      @Override
      @NonNull
      public String createQuery() {
        final String _query = "DELETE FROM vehicles WHERE tenantId = ?";
        return _query;
      }
    };
  }

  @Override
  public Object insertVehicles(final List<VehicleEntity> vehicles,
      final Continuation<? super Unit> $completion) {
    return CoroutinesRoom.execute(__db, true, new Callable<Unit>() {
      @Override
      @NonNull
      public Unit call() throws Exception {
        __db.beginTransaction();
        try {
          __insertionAdapterOfVehicleEntity.insert(vehicles);
          __db.setTransactionSuccessful();
          return Unit.INSTANCE;
        } finally {
          __db.endTransaction();
        }
      }
    }, $completion);
  }

  @Override
  public Object clearVehicles(final String tenantId, final Continuation<? super Unit> $completion) {
    return CoroutinesRoom.execute(__db, true, new Callable<Unit>() {
      @Override
      @NonNull
      public Unit call() throws Exception {
        final SupportSQLiteStatement _stmt = __preparedStmtOfClearVehicles.acquire();
        int _argIndex = 1;
        _stmt.bindString(_argIndex, tenantId);
        try {
          __db.beginTransaction();
          try {
            _stmt.executeUpdateDelete();
            __db.setTransactionSuccessful();
            return Unit.INSTANCE;
          } finally {
            __db.endTransaction();
          }
        } finally {
          __preparedStmtOfClearVehicles.release(_stmt);
        }
      }
    }, $completion);
  }

  @Override
  public Object getVehicles(final String tenantId,
      final Continuation<? super List<VehicleEntity>> $completion) {
    final String _sql = "SELECT * FROM vehicles WHERE tenantId = ? ORDER BY unitNumber";
    final RoomSQLiteQuery _statement = RoomSQLiteQuery.acquire(_sql, 1);
    int _argIndex = 1;
    _statement.bindString(_argIndex, tenantId);
    final CancellationSignal _cancellationSignal = DBUtil.createCancellationSignal();
    return CoroutinesRoom.execute(__db, false, _cancellationSignal, new Callable<List<VehicleEntity>>() {
      @Override
      @NonNull
      public List<VehicleEntity> call() throws Exception {
        final Cursor _cursor = DBUtil.query(__db, _statement, false, null);
        try {
          final int _cursorIndexOfId = CursorUtil.getColumnIndexOrThrow(_cursor, "id");
          final int _cursorIndexOfTenantId = CursorUtil.getColumnIndexOrThrow(_cursor, "tenantId");
          final int _cursorIndexOfUnitNumber = CursorUtil.getColumnIndexOrThrow(_cursor, "unitNumber");
          final int _cursorIndexOfVin = CursorUtil.getColumnIndexOrThrow(_cursor, "vin");
          final int _cursorIndexOfMake = CursorUtil.getColumnIndexOrThrow(_cursor, "make");
          final int _cursorIndexOfModel = CursorUtil.getColumnIndexOrThrow(_cursor, "model");
          final List<VehicleEntity> _result = new ArrayList<VehicleEntity>(_cursor.getCount());
          while (_cursor.moveToNext()) {
            final VehicleEntity _item;
            final String _tmpId;
            _tmpId = _cursor.getString(_cursorIndexOfId);
            final String _tmpTenantId;
            _tmpTenantId = _cursor.getString(_cursorIndexOfTenantId);
            final String _tmpUnitNumber;
            _tmpUnitNumber = _cursor.getString(_cursorIndexOfUnitNumber);
            final String _tmpVin;
            _tmpVin = _cursor.getString(_cursorIndexOfVin);
            final String _tmpMake;
            _tmpMake = _cursor.getString(_cursorIndexOfMake);
            final String _tmpModel;
            _tmpModel = _cursor.getString(_cursorIndexOfModel);
            _item = new VehicleEntity(_tmpId,_tmpTenantId,_tmpUnitNumber,_tmpVin,_tmpMake,_tmpModel);
            _result.add(_item);
          }
          return _result;
        } finally {
          _cursor.close();
          _statement.release();
        }
      }
    }, $completion);
  }

  @NonNull
  public static List<Class<?>> getRequiredConverters() {
    return Collections.emptyList();
  }
}
